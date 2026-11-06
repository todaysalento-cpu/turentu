import { contabilizzaPagamento } from './contabilizzazione.service.js';

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function positiveId(value) {
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

// Compatibilita con l'ID corsa esposto dal pannello esistente.
// Nessuna cattura/rimborso: riconcilia soltanto operazioni gia concluse su Stripe.
export async function reconcileAdminPayment({ pool, stripe, corsaId, paymentId, action }) {
  if (!['rilascia', 'rimborso'].includes(action)) reject(400, 'Azione pagamento non valida');
  if (!positiveId(corsaId) || (paymentId != null && !positiveId(paymentId))) {
    reject(400, 'Identificativo pagamento/corsa non valido');
  }
  if (!stripe) reject(503, 'Stripe non configurato');
  const client = await pool.connect();
  let tx = false;
  try {
    await client.query('BEGIN'); tx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    // Stesso ordine del servizio di chiusura: corsa prima del pagamento.
    const ride = await client.query('SELECT id FROM public.corse WHERE id=$1 FOR UPDATE', [corsaId]);
    if (ride.rows.length !== 1) reject(404, 'Corsa non trovata');
    const { rows } = await client.query(`
      SELECT p.id, p.stato, p.importo, p.currency, p.stripe_payment_intent,
             pr.prezzo_totale
      FROM public.pagamenti p
      JOIN public.prenotazioni pr ON pr.id=p.prenotazione_id
      WHERE pr.corsa_id=$1 AND (p.corsa_id IS NULL OR p.corsa_id=pr.corsa_id)
        AND ($2::integer IS NULL OR p.id=$2)
      ORDER BY p.id FOR UPDATE OF p, pr`, [corsaId, paymentId ?? null]);
    if (!rows.length) reject(404, 'Pagamento non trovato');
    if (rows.length !== 1) reject(409, 'Piu pagamenti per questa corsa: specificare pagamento_id');
    const payment = rows[0];
    if (!String(payment.stripe_payment_intent || '').startsWith('pi_')) {
      reject(409, 'Pagamento non Stripe: usare il relativo flusso contabile');
    }
    const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent, {
      expand: ['latest_charge'],
    });
    const expected = Math.round(Number(payment.prezzo_totale ?? payment.importo) * 100);
    if (!Number.isSafeInteger(expected) || expected <= 0 ||
        intent.id !== payment.stripe_payment_intent || intent.currency !== 'eur' ||
        (payment.currency && String(payment.currency).toLowerCase() !== 'eur') ||
        intent.status !== 'succeeded' || intent.amount_received !== expected) {
      reject(409, 'Incasso Stripe non confermato o importo incoerente: usare la chiusura corsa');
    }
    const charge = intent.latest_charge;
    if (!charge || typeof charge !== 'object' || charge.payment_intent !== intent.id ||
        charge.currency !== 'eur' || charge.status !== 'succeeded' ||
        charge.captured !== true || charge.amount_captured !== expected) {
      reject(409, 'Movimento Stripe non verificabile');
    }
    const target = action === 'rilascia' ? 'pagato' : 'rimborsato';
    if (target === 'pagato') {
      if (!['pendente', 'autorizzazione', 'pagato'].includes(payment.stato) ||
          charge.refunded !== false || charge.amount_refunded !== 0) {
        reject(409, 'Pagamento non riconciliabile come incassato');
      }
    } else if (!['pagato', 'rimborsato'].includes(payment.stato) ||
               charge.refunded !== true || charge.amount_refunded !== expected) {
      reject(409, 'Rimborso integrale non confermato su Stripe');
    }
    await client.query(`UPDATE public.pagamenti
      SET stato=$1, importo=$2, updated_at=NOW() WHERE id=$3`,
    [target, expected / 100, payment.id]);
    if (target === 'pagato') await contabilizzaPagamento(client, payment.id);
    await client.query('COMMIT'); tx = false;
    return { pagamento_id: payment.id, stato: target, riconciliato: true };
  } catch (error) {
    if (tx) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
