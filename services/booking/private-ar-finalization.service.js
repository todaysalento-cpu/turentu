import { assegnaConducente } from '../conducenti/assegnazioni.service.js';
import { createCorsaFromPending } from '../corsa/corsa.service.js';
import { getArGroupForUpdate, transitionArGroup } from './ar-coordinator.service.js';
import { verificaGruppoARTransazionale } from './ar-transaction.service.js';

function requireState(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code, status: 409 });
}

// Il coordinatore NCC detiene la transazione del gruppo e i lock dei veicoli.
export async function finalizzaPrivataAR(client, groupId, stripe, { assegna = false } = {}) {
  const group = await getArGroupForUpdate(client, groupId);
  requireState(group.andata_tipo === 'privata' && group.ritorno_tipo === 'privata',
    'PRIVATE_AR_GROUP_TYPE_INVALID');

  const { rows: legs } = await client.query(`
    SELECT p.*, extract(epoch from p.durata) / 60 AS durata_minuti,
           ST_Y(p.origine::geometry) AS origine_lat, ST_X(p.origine::geometry) AS origine_lon,
           ST_Y(p.destinazione::geometry) AS destinazione_lat, ST_X(p.destinazione::geometry) AS destinazione_lon,
           v.posti_totali, v.driver_id,
           ST_Y(v.coord::geometry) AS lat_base, ST_X(v.coord::geometry) AS lon_base
    FROM pending p JOIN veicolo v ON v.id = p.veicolo_id
    WHERE p.ar_group_id = $1
    ORDER BY p.id FOR UPDATE OF p
  `, [groupId]);
  requireState(legs.length === 2 && new Set(legs.map(leg => leg.ar_tratta)).size === 2 &&
    legs.every(leg => ['andata', 'ritorno'].includes(leg.ar_tratta) &&
      leg.ar_vincolata === true && leg.tipo_corsa === 'privata' &&
      String(leg.cliente_id) === String(group.cliente_id)), 'PRIVATE_AR_LEGS_INVALID');
  if (group.stato === 'confermato') {
    requireState(legs.every(leg => leg.stato === 'accettata' && leg.corsa_id),
      'PRIVATE_AR_CONFIRMED_LEGS_INVALID');
    return legs.map(leg => ({ tratta: leg.ar_tratta, corsaId: leg.corsa_id }));
  }

  requireState(group.stato === 'in_attesa' && legs.every(leg =>
    leg.stato === 'pending' && !leg.corsa_id && new Date(leg.expires_at) > new Date()) &&
    legs.every(leg => leg.payment_intent_id) &&
    legs[0].payment_intent_id !== legs[1].payment_intent_id, 'PRIVATE_AR_STATE_INVALID');

  const preflight = await verificaGruppoARTransazionale(groupId, { client });
  requireState(preflight.verificato === true, 'PRIVATE_AR_PREFLIGHT_FAILED');
  for (const leg of legs) {
    const cents = Number(group[`prezzo_${leg.ar_tratta}_cents`]);
    const intent = await stripe.paymentIntents.retrieve(leg.payment_intent_id);
    requireState(Number.isSafeInteger(cents) && cents >= 50 &&
      Math.round(Number(leg.prezzo) * 100) === cents &&
      intent.status === 'requires_capture' && intent.capture_method === 'manual' &&
      intent.currency === 'eur' && intent.amount === cents && intent.amount_capturable >= cents &&
      intent.metadata?.ar_group_id === groupId && intent.metadata?.ar_tratta === leg.ar_tratta &&
      intent.metadata?.clienteId === String(group.cliente_id), 'PRIVATE_AR_PAYMENT_INVALID');
  }

  const choices = assegna ? await client.query(`SELECT pending_id, scelta_conducente
    FROM ar_accettazioni WHERE ar_group_id = $1 AND stato = 'provvisoria'`, [groupId]) : null;
  await transitionArGroup(client, groupId, 'in_attesa', 'pronto');
  const result = [];
  for (const leg of [...legs].sort((a, b) => Number(a.driver_id) - Number(b.driver_id))) {
    const corsa = await createCorsaFromPending(leg, {
      id: leg.veicolo_id,
      posti: leg.posti_totali,
      posti_totali: leg.posti_totali, lat_base: leg.lat_base, lon_base: leg.lon_base
    }, client);
    if (assegna) {
      const scelta = choices.rows.find(row => String(row.pending_id) === String(leg.id))?.scelta_conducente;
      const ciclo = corsa.cicloOperativoNcc;
      requireState(scelta && ciclo, 'PRIVATE_AR_DRIVER_OR_CYCLE_MISSING');
      await assegnaConducente(client, {
        operatoreId: leg.driver_id, veicoloId: leg.veicolo_id, corsaId: corsa.id,
        inizio: ciclo.inizio, fine: ciclo.fine, modalita: scelta.modalita,
        conducenteId: scelta.modalita === 'titolare' ? leg.driver_id : scelta.conducenteId,
        confermaDeroga: scelta.confermaDeroga, motivoDeroga: scelta.motivoDeroga,
        autorizzatoreId: scelta.confermaDeroga === true ? leg.driver_id : undefined
      });
    }
    const booking = await client.query(`
      SELECT id FROM prenotazioni
      WHERE corsa_id = $1 AND cliente_id = $2 AND ar_group_id = $3 AND ar_tratta = $4
    `, [corsa.id, leg.cliente_id, groupId, leg.ar_tratta]);
    requireState(booking.rowCount === 1, 'PRIVATE_AR_BOOKING_INVALID');
    const payment = await client.query(`
      INSERT INTO pagamenti (prenotazione_id, importo, stato, stripe_payment_intent, corsa_id, updated_at)
      VALUES ($1, $2, 'autorizzazione', $3, $4, now())
      ON CONFLICT (stripe_payment_intent) DO UPDATE
        SET prenotazione_id = EXCLUDED.prenotazione_id, corsa_id = EXCLUDED.corsa_id
      WHERE pagamenti.stato = 'autorizzazione'
        AND (pagamenti.prenotazione_id IS NULL OR pagamenti.prenotazione_id = EXCLUDED.prenotazione_id)
        AND (pagamenti.corsa_id IS NULL OR pagamenti.corsa_id = EXCLUDED.corsa_id)
    `, [booking.rows[0].id, leg.prezzo, leg.payment_intent_id, corsa.id]);
    requireState(payment.rowCount === 1, 'PRIVATE_AR_PAYMENT_LINK_FAILED');
    await client.query(`
      INSERT INTO chat_threads (corsa_id, cliente_id, driver_id, updated_at)
      VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING
    `, [corsa.id, leg.cliente_id, leg.driver_id]);
    const pending = await client.query(`
      UPDATE pending SET stato = 'accettata', corsa_id = $2
      WHERE id = $1 AND stato = 'pending' AND corsa_id IS NULL
    `, [leg.id, corsa.id]);
    requireState(pending.rowCount === 1, 'PRIVATE_AR_PENDING_UPDATE_FAILED');
    result.push({ tratta: leg.ar_tratta, corsaId: corsa.id });
  }
  await transitionArGroup(client, groupId, 'pronto', 'confermato');
  return result;
}
