// Turentu POPBUS V2 - prenotazione di corse confermate.
// INTEGRAZIONE NON ANCORA ATTIVA: chiamare solo con quotazione ricalcolata sul server.
// Richiede prenotazione.service.js con supporto options.popbusRiservaId.
import { pool } from '../../../db/db.js';
import { prenotaCorsa } from '../../prenotazione/prenotazione.service.js';
import { calcolaPicco } from '../../../utils/occupazione.util.js';
import Stripe from 'stripe';

const TTL_MINUTI = 30;
const errore = (messaggio, status = 409) => Object.assign(new Error(messaggio), { status });
const positiveInt = v => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const euroCent = v => Math.round(Number(v) * 100);
const stripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw errore('Stripe non configurato', 503);
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });
};

async function transazione(work, providedClient) {
  const owned = !providedClient;
  const client = providedClient || await pool.connect();
  try {
    if (owned) await client.query('BEGIN');
    const result = await work(client);
    if (owned) await client.query('COMMIT');
    return result;
  } catch (e) {
    if (owned) await client.query('ROLLBACK');
    throw e;
  } finally {
    if (owned) client.release();
  }
}

async function lockCorsaConfermata(client, corsaId) {
  const { rows } = await client.query(`
    SELECT c.id, c.tipo_corsa, c.stato, c.posti_totali, c.veicolo_id
    FROM public.corse c
    WHERE c.id=$1 FOR UPDATE OF c
  `, [corsaId]);
  const corsa = rows[0];
  if (!corsa || corsa.tipo_corsa !== 'riempimento' || corsa.stato !== 'prenotabile') {
    throw errore('Corsa POPBUS non prenotabile');
  }
  const { rows: attivazioni } = await client.query(`
    SELECT id FROM public.popbus_attivazioni
    WHERE corsa_id=$1 AND stato='confermata' LIMIT 1
  `, [corsaId]);
  // ATTENZIONE: adattare il valore 'confermata' se lo stato effettivo di
  // popbus_attivazioni in produzione usa un nome diverso.
  if (!attivazioni.length) throw errore('Attivazione POPBUS non confermata');
  return corsa;
}

async function intervalliOccupati(client, corsaId, excludeRiservaId = null) {
  const { rows: bookings } = await client.query(`
    SELECT start_offset, end_offset, posti_richiesti
    FROM public.prenotazioni WHERE corsa_id=$1
  `, [corsaId]);
  const { rows: reservations } = await client.query(`
    SELECT start_offset, end_offset, posti_richiesti
    FROM public.popbus_riserve
    WHERE corsa_id=$1 AND stato='riservata' AND expires_at > NOW()
      AND ($2::bigint IS NULL OR id <> $2::bigint)
  `, [corsaId, excludeRiservaId]);
  return [...bookings, ...reservations].map(row => {
    const start = Number(row.start_offset), end = Number(row.end_offset);
    const posti = Number(row.posti_richiesti);
    if (![start, end, posti].every(Number.isFinite) || start < 0 || end <= start || !positiveInt(posti)) {
      throw errore('Occupazione esistente non valida: verifica dati necessaria');
    }
    return { start, end, posti };
  });
}

// Il chiamante DEVE aver verificato sul server compatibilita' spaziale,
// temporale, geometria, indici e prezzo; NON passare dati client non validati.
export async function riservaPostiPopbus({
  requestId, corsaId, clienteId, postiRichiesti,
  startOffset, endOffset, startIndexPolyline, endIndexPolyline, prezzo
}, clientEsterno = null) {
  if (!requestId || !positiveInt(corsaId) || !positiveInt(clienteId) || !positiveInt(postiRichiesti) ||
      !Number.isFinite(Number(startOffset)) || !Number.isFinite(Number(endOffset)) ||
      Number(startOffset) < 0 || Number(endOffset) <= Number(startOffset) ||
      !Number.isInteger(Number(startIndexPolyline)) || Number(startIndexPolyline) < 0 ||
      !Number.isInteger(Number(endIndexPolyline)) || Number(endIndexPolyline) <= Number(startIndexPolyline) ||
      !Number.isFinite(Number(prezzo)) || euroCent(prezzo) < 50) {
    throw errore('Dati riserva non validi', 400);
  }
  return transazione(async client => {
    const corsa = await lockCorsaConfermata(client, corsaId);
    const { rows: duplicates } = await client.query(
      'SELECT id FROM public.popbus_riserve WHERE request_id=$1', [requestId]
    );
    if (duplicates.length) throw errore('Richiesta gia\' registrata');
    const intervals = await intervalliOccupati(client, corsaId);
    intervals.push({ start: Number(startOffset), end: Number(endOffset), posti: Number(postiRichiesti) });
    const picco = calcolaPicco(intervals);
    if (!positiveInt(corsa.posti_totali) || picco > Number(corsa.posti_totali)) {
      throw errore('Posti POPBUS non piu\' disponibili');
    }
    const { rows } = await client.query(`
      INSERT INTO public.popbus_riserve
        (request_id, corsa_id, cliente_id, posti_richiesti,
         start_offset, end_offset, start_index_polyline, end_index_polyline,
         prezzo, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + ($10::int * INTERVAL '1 minute'))
      RETURNING *
    `, [requestId, corsaId, clienteId, postiRichiesti, startOffset, endOffset,
        startIndexPolyline, endIndexPolyline, prezzo, TTL_MINUTI]);
    return rows[0];
  }, clientEsterno);
}

// Associa un PaymentIntent creato per questa riserva. Deve essere invocato
// PRIMA della conferma del pagamento. Metadata obbligatori: tipo, riservaId,
// corsaId, clienteId, requestId. Il PaymentIntent deve usare manual capture.
export async function collegaPaymentIntentPopbus({ riservaId, clienteId, paymentIntentId }) {
  if (!positiveInt(riservaId) || !positiveInt(clienteId) || !paymentIntentId) {
    throw errore('Parametri collegamento pagamento non validi', 400);
  }
  const pi = await stripeClient().paymentIntents.retrieve(String(paymentIntentId));
  return transazione(async client => {
    const { rows: existing } = await client.query(
      'SELECT corsa_id FROM public.popbus_riserve WHERE id=$1', [riservaId]
    );
    if (!existing.length) throw errore('Riserva non trovata');
    await lockCorsaConfermata(client, existing[0].corsa_id);
    const { rows } = await client.query(`
      SELECT * FROM public.popbus_riserve WHERE id=$1 FOR UPDATE
    `, [riservaId]);
    const r = rows[0];
    if (!r || Number(r.cliente_id) !== Number(clienteId) || r.stato !== 'riservata' ||
        new Date(r.expires_at) <= new Date() || r.payment_intent_id) {
      throw errore('Riserva non collegabile al pagamento');
    }
    verificaIdentitaIntent(pi, r);
    if (!['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture'].includes(pi.status)) {
      throw errore('PaymentIntent non utilizzabile');
    }
    const { rows: updated } = await client.query(`
      UPDATE public.popbus_riserve
      SET payment_intent_id=$2, updated_at=NOW() WHERE id=$1 RETURNING *
    `, [riservaId, pi.id]);
    return updated[0];
  });
}

function verificaIdentitaIntent(pi, r) {
  if (!pi || pi.currency !== 'eur' || pi.capture_method !== 'manual' ||
      pi.amount !== euroCent(r.prezzo) ||
      pi.metadata?.tipo !== 'popbus_confirmed' ||
      String(pi.metadata?.riservaId) !== String(r.id) ||
      String(pi.metadata?.corsaId) !== String(r.corsa_id) ||
      String(pi.metadata?.clienteId) !== String(r.cliente_id) ||
      String(pi.metadata?.requestId) !== String(r.request_id)) {
    throw errore('Identita\' o importo PaymentIntent non coerenti');
  }
}

// Chiamare dopo l'autorizzazione (requires_capture), mai alla sola creazione
// del PaymentIntent. Non esegue la capture.
export async function confermaPrenotazionePopbus({ riservaId, clienteId }) {
  if (!positiveInt(riservaId) || !positiveInt(clienteId)) throw errore('Parametri non validi', 400);
  // Prima lettura: il controllo effettivo avviene di nuovo sotto lock.
  const { rows: preliminari } = await pool.query(
    'SELECT payment_intent_id FROM public.popbus_riserve WHERE id=$1 AND cliente_id=$2',
    [riservaId, clienteId]
  );
  if (!preliminari.length || !preliminari[0].payment_intent_id) throw errore('Riserva senza pagamento');
  const pi = await stripeClient().paymentIntents.retrieve(preliminari[0].payment_intent_id);
  return transazione(async client => {
    const { rows: locator } = await client.query(
      'SELECT corsa_id FROM public.popbus_riserve WHERE id=$1', [riservaId]
    );
    if (!locator.length) throw errore('Riserva non trovata');
    const corsa = await lockCorsaConfermata(client, locator[0].corsa_id);
    const { rows } = await client.query(
      'SELECT * FROM public.popbus_riserve WHERE id=$1 FOR UPDATE', [riservaId]
    );
    const r = rows[0];
    if (!r || Number(r.cliente_id) !== Number(clienteId)) throw errore('Riserva non valida');
    if (r.stato === 'confermata' && r.prenotazione_id) {
      return { prenotazioneId: r.prenotazione_id, giaConfermata: true };
    }
    if (r.stato !== 'riservata' || new Date(r.expires_at) <= new Date()) {
      throw errore('Riserva scaduta o non disponibile');
    }
    if (r.payment_intent_id !== pi.id) throw errore('PaymentIntent modificato');
    verificaIdentitaIntent(pi, r);
    if (pi.status !== 'requires_capture' || pi.amount_capturable < euroCent(r.prezzo)) {
      throw errore('Pagamento non ancora autorizzato');
    }
    const prenotazione = await prenotaCorsa(
      { id: corsa.id }, r.cliente_id, r.posti_richiesti,
      {
        startIdx: r.start_index_polyline, endIdx: r.end_index_polyline,
        startOffset: r.start_offset, endOffset: r.end_offset
      }, client, { popbusRiservaId: r.id }
    );
    await client.query(`
      UPDATE public.prenotazioni SET prezzo_totale=$2 WHERE id=$1
    `, [prenotazione.id, r.prezzo]);
    await client.query(`
      UPDATE public.popbus_riserve
      SET stato='confermata', prenotazione_id=$2, updated_at=NOW()
      WHERE id=$1 AND stato='riservata'
    `, [r.id, prenotazione.id]);
    const paymentWrite = await client.query(`
      INSERT INTO public.pagamenti
        (prenotazione_id, importo, stato, stripe_payment_intent, corsa_id, updated_at)
      VALUES ($1,$2,'autorizzazione',$3,$4,NOW())
      ON CONFLICT (stripe_payment_intent)
      DO UPDATE SET updated_at=NOW()
      WHERE pagamenti.prenotazione_id=EXCLUDED.prenotazione_id
        AND pagamenti.corsa_id=EXCLUDED.corsa_id
    `, [prenotazione.id, r.prezzo, pi.id, r.corsa_id]);
    if (paymentWrite.rowCount !== 1) throw errore('PaymentIntent gia\' associato ad altra prenotazione');
    return { prenotazioneId: prenotazione.id, corsaId: r.corsa_id, giaConfermata: false };
  });
}

// La scadenza logica libera immediatamente la capienza. La riconciliazione
// Stripe/cancellazione dell'autorizzazione va gestita separatamente.
export async function rilasciaRiservaPopbus({ riservaId, clienteId = null, scaduta = false }) {
  if (!positiveInt(riservaId)) throw errore('ID riserva non valido', 400);
  return transazione(async client => {
    const { rows: locator } = await client.query(
      'SELECT corsa_id FROM public.popbus_riserve WHERE id=$1', [riservaId]
    );
    if (!locator.length) throw errore('Riserva non trovata');
    await client.query('SELECT id FROM public.corse WHERE id=$1 FOR UPDATE', [locator[0].corsa_id]);
    const { rows } = await client.query(
      'SELECT * FROM public.popbus_riserve WHERE id=$1 FOR UPDATE', [riservaId]
    );
    const r = rows[0];
    if (clienteId != null && Number(r.cliente_id) !== Number(clienteId)) throw errore('Riserva non autorizzata', 403);
    if (r.stato === 'confermata') throw errore('Prenotazione gia\' confermata');
    if (r.stato !== 'riservata') return r;
    const { rows: updated } = await client.query(`
      UPDATE public.popbus_riserve SET stato=$2, updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [riservaId, scaduta ? 'scaduta' : 'annullata']);
    return updated[0];
  });
}
