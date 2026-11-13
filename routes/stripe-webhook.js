import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import * as pendingService from '../services/pending/pending.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';
import { getIO } from '../socket.js';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('[STRIPE WEBHOOK] STRIPE_SECRET_KEY mancante');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

const router = express.Router();

/**
 * Il webhook deve ricevere il body originale per verificare
 * la firma Stripe. In server.js deve essere montato prima
 * di express.json().
 */
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      console.error('[STRIPE WEBHOOK] STRIPE_WEBHOOK_SECRET mancante');
      return res.status(500).json({
        error: 'Configurazione webhook mancante',
      });
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('[STRIPE WEBHOOK] Firma non valida:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    let client;
    const notifiche = [];
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const intent = event.data.object;
      const metadata = intent.metadata || {};

      const tipo = metadata.tipo;
      const pendingId = metadata.pendingId
        ? Number(metadata.pendingId)
        : null;
      const corsaId = metadata.corsaId
        ? Number(metadata.corsaId)
        : null;
      const clienteId = metadata.clienteId
        ? Number(metadata.clienteId)
        : null;

      const roomId = corsaId || pendingId;

      switch (event.type) {
        case 'payment_intent.amount_capturable_updated': {
          await aggiornaStato(
            intent.id,
            'autorizzazione',
            client,
            intent
          );
          break;
        }

        case 'payment_intent.succeeded': {
          await handlePaymentSuccess({
            intent,
            tipo,
            pendingId,
            corsaId,
            clienteId,
            roomId,
            client,
            notifiche,
          });
          break;
        }

        case 'payment_intent.payment_failed': {
          await handlePaymentFailed({
            intent,
            roomId,
            stato: 'fallito',
            client,
            notifiche,
          });
          break;
        }

        case 'payment_intent.canceled': {
          await handlePaymentFailed({
            intent,
            roomId,
            stato: 'annullato',
            client,
            notifiche,
          });
          break;
        }

        default:
          console.log(
            `[STRIPE WEBHOOK] Evento ignorato: ${event.type}`
          );
      }

      await client.query('COMMIT');
      // Nessuna notifica prima del COMMIT. Un errore Socket.IO non
      // deve far ritentare un evento Stripe gia' confermato nel DB.
      for (const notifica of notifiche) {
        try {
          getIO().to(notifica.room).emit('prenotazione_update', notifica.payload);
        } catch (notifyError) {
          console.error('[STRIPE WEBHOOK] Notifica post-COMMIT fallita:', notifyError.message);
        }
      }
      return res.json({ received: true });
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
          console.error('[STRIPE WEBHOOK] Rollback fallito:', rollbackError.message);
        }
      }
      console.error(
        '[STRIPE WEBHOOK] Errore durante la gestione evento:',
        err.message
      );

      return res.status(500).json({
        error: 'Webhook handling error',
      });
    } finally {
      if (client) client.release();
    }
  }
);

// =====================================================
// RICONOSCIMENTO AUTORIZZAZIONI POPBUS PRIMA DELL'ATTIVAZIONE
// =====================================================

// Le richieste POPBUS sono inizialmente in richieste_pop_bus.
// Il record in pagamenti nasce solo durante la conversione in corsa.
// Questa funzione NON crea pagamenti, NON converte richieste e NON cattura fondi.
async function riconosciRichiestaPopbus(client, stripeIntentId, stato, intent) {
  const result = await client.query(
    `SELECT id, stato, cliente_id, prezzo, prezzo_massimo_autorizzato, payment_intent_id
       FROM public.richieste_pop_bus
      WHERE payment_intent_id = $1
      FOR UPDATE`,
    [stripeIntentId]
  );

  if (!result.rowCount) return false;
  if (result.rowCount !== 1) {
    throw new Error(`PaymentIntent POPBUS associato a piu richieste: ${stripeIntentId}`);
  }

  const richiesta = result.rows[0];
  const metadata = intent?.metadata || {};
  if (metadata.tipo !== 'popbus' ||
      (metadata.clienteId && Number(metadata.clienteId) !== Number(richiesta.cliente_id))) {
    throw new Error(`Identita PaymentIntent POPBUS incoerente: ${stripeIntentId}`);
  }

  if (stato === 'autorizzazione') {
    if (!intent || intent.id !== stripeIntentId ||
        intent.status !== 'requires_capture' ||
        intent.capture_method !== 'manual' ||
        String(intent.currency).toLowerCase() !== 'eur') {
      throw new Error(`Autorizzazione POPBUS Stripe non valida: ${stripeIntentId}`);
    }
    const previsto = Math.round(Number(richiesta.prezzo_massimo_autorizzato ?? richiesta.prezzo) * 100);
    if (richiesta.prezzo_massimo_autorizzato != null && Number(intent.amount) !== previsto) {
      throw new Error('Tetto autorizzato PopBus non coerente con Stripe');
    }
    const disponibile = Number(intent.amount_capturable);
    if (!Number.isSafeInteger(previsto) || previsto <= 0 ||
        !Number.isSafeInteger(disponibile) || disponibile < previsto) {
      throw new Error(`Importo autorizzato POPBUS insufficiente: ${stripeIntentId}`);
    }
    // Il webhook puo arrivare dopo la conversione o dopo una variazione di stato.
    // Non alterare mai lo stato commerciale della richiesta.
    console.log(`[STRIPE WEBHOOK] POPBUS ${richiesta.id}: autorizzazione riconosciuta (${richiesta.stato}); pagamento differito all'attivazione`);
    return true;
  }

  // Il webhook non e' il proprietario della cattura o della riconciliazione
  // POPBUS. In particolare, un succeeded non converte la richiesta in corsa.
  console.log(`[STRIPE WEBHOOK] POPBUS ${richiesta.id}: evento ${stato} riconosciuto; nessuna modifica automatica alla richiesta`);
  return true;
}

// =====================================================
// AGGIORNAMENTO STATO PAGAMENTO
// =====================================================

// La funzione restituisce true soltanto se modifica realmente pagamenti.
// I pagamenti associati a una corsa NCC sono riconciliati esclusivamente
// da corse.service.js: il webhook non anticipa la chiusura della corsa.
async function aggiornaStato(stripeIntentId, stato, client, intent = null) {
  const statiConsentiti = new Set([
    'autorizzazione', 'pagato', 'annullato', 'fallito'
  ]);
  if (!statiConsentiti.has(stato)) {
    throw new Error(`Stato pagamento non consentito: ${stato}`);
  }

  const result = await client.query(
    `SELECT p.id, p.stato, p.importo, p.currency,
            COALESCE(p.corsa_id, pr.corsa_id) AS corsa_id
       FROM public.pagamenti p
       LEFT JOIN public.prenotazioni pr ON pr.id = p.prenotazione_id
      WHERE p.stripe_payment_intent = $1
      FOR UPDATE OF p`,
    [stripeIntentId]
  );
  if (!result.rowCount) {
    const riconosciuto = await riconosciRichiestaPopbus(client, stripeIntentId, stato, intent);
    if (!riconosciuto) {
      console.warn(`[STRIPE WEBHOOK] Pagamento DB non trovato: ${stripeIntentId}`);
    }
    return false;
  }

  const pagamento = result.rows[0];
  if (pagamento.stato === stato ||
      ['pagato', 'rimborsato'].includes(pagamento.stato)) {
    return false;
  }

  // Non far retrocedere stati terminali e non riaprire autorizzazioni.
  if (stato === 'autorizzazione') {
    if (pagamento.stato !== 'pendente' ||
        (intent && intent.status !== 'requires_capture')) return false;
  } else if (stato === 'pagato') {
    if (!intent || intent.status !== 'succeeded' ||
        String(intent.currency).toLowerCase() !== 'eur') {
      throw new Error('Incasso Stripe non valido');
    }
    const ricevuto = Number(intent.amount_received);
    if (!Number.isSafeInteger(ricevuto) || ricevuto <= 0) {
      throw new Error('Importo Stripe non valido');
    }
    // Non confrontare importo autorizzato e importo finale Modello A:
    // possono differire. La riconciliazione e' nel servizio di chiusura.
    if (pagamento.corsa_id != null) {
      console.log(`[STRIPE WEBHOOK] Incasso corsa ${pagamento.corsa_id}: riconciliazione NCC delegata`);
      return false;
    }
    const previsto = Math.round(Number(pagamento.importo) * 100);
    if (!Number.isSafeInteger(previsto) || previsto <= 0 || ricevuto !== previsto ||
        (pagamento.currency && String(pagamento.currency).toLowerCase() !== 'eur')) {
      throw new Error(`Incasso Stripe non coerente con pagamento DB ${pagamento.id}`);
    }
    if (!['pendente', 'autorizzazione'].includes(pagamento.stato)) return false;
  } else if (stato === 'fallito') {
    if (pagamento.stato !== 'pendente') return false;
  } else if (stato === 'annullato') {
    if (!['pendente', 'autorizzazione'].includes(pagamento.stato)) return false;
  }

  await client.query(
    `UPDATE public.pagamenti SET stato = $1, updated_at = NOW() WHERE id = $2`,
    [stato, pagamento.id]
  );
  return true;
}

// =====================================================
// PAGAMENTO COMPLETATO
// =====================================================

async function handlePaymentSuccess({
  intent,
  tipo,
  pendingId,
  corsaId,
  clienteId,
  roomId,
  client,
  notifiche,
}) {
  // A/R vincolata: il webhook non puo' confermare una singola tratta,
  // creare corse o riconciliare incassi senza il coordinatore A/R.
  // Il 500 mantiene visibile l'anomalia e consente il retry Stripe.
  const arLeg = await client.query(`
    SELECT ar_group_id FROM public.pending
    WHERE payment_intent_id = $1 AND ar_vincolata = TRUE
    UNION ALL
    SELECT ar_group_id FROM public.richieste_pop_bus
    WHERE payment_intent_id = $1 AND ar_vincolata = TRUE
    LIMIT 1
  `, [intent.id]);
  if (arLeg.rowCount > 0) {
    const error = new Error(`Incasso A/R non gestibile dal webhook singolo: gruppo ${arLeg.rows[0].ar_group_id}`);
    error.code = 'AR_WEBHOOK_CAPTURE_NOT_READY';
    throw error;
  }

  const aggiornato = await aggiornaStato(intent.id, 'pagato', client, intent);
  if (!aggiornato) return;

  // Prenotazione gia' esistente.
  if (tipo === 'prenota' && corsaId) {
    notifiche.push({ room: `prenotazione_cliente_${roomId}`, payload: { status: 'pagato', paymentIntentId: intent.id, corsaId } });
    return;
  }

  // Richiesta che deve generare una corsa dal pending.
  if (tipo === 'richiedi' && pendingId) {
    const pending = await pendingService.getPendingById(
      pendingId,
      client
    );

    if (!pending) {
      throw new Error(`Pending ${pendingId} non trovato`);
    }

    const veicoloRes = await client.query(
      `SELECT *
       FROM public.veicolo
       WHERE id = $1`,
      [pending.veicolo_id]
    );

    const veicolo = veicoloRes.rows[0];

    if (!veicolo) {
      throw new Error('Veicolo non trovato');
    }

    const { corsa, prenotazione } =
      await createCorsaFromPending(
        pending,
        veicolo,
        client
      );

    console.log(
      '[STRIPE WEBHOOK] Corsa creata da pending:',
      corsa.id,
      'Prenotazione:',
      prenotazione?.id
    );

    await pendingService.updatePendingStatus(
      pendingId,
      'processed',
      client
    );

    notifiche.push({ room: `prenotazione_cliente_${roomId}`, payload: { status: 'pagato', paymentIntentId: intent.id, pendingId } });
    return;
  }

  // Nessuna cattura a cascata nel webhook.
  // La cattura NCC avviene esclusivamente alla chiusura in corse.service.js.
  void clienteId;
}

// =====================================================
// PAGAMENTO FALLITO O PAYMENT INTENT ANNULLATO
// =====================================================

async function handlePaymentFailed({
  intent,
  roomId,
  stato,
  client,
  notifiche,
}) {
  if (!['fallito', 'annullato'].includes(stato)) {
    throw new Error(`Esito pagamento non valido: ${stato}`);
  }

  const aggiornato = await aggiornaStato(intent.id, stato, client, intent);
  if (!aggiornato) return;

  notifiche.push({ room: `prenotazione_cliente_${roomId}`, payload: { status: stato, paymentIntentId: intent.id } });

  console.log(
    `[STRIPE WEBHOOK] PaymentIntent ${intent.id}: ${stato}`
  );
}

export { router };
