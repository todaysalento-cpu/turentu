/**
 * TURENTU — STEP 4.33: accettazione provvisoria A/R atomica.
 * Non esporre in produzione finche' tutti i percorsi NCC/POPBUS
 * non condividono il protocollo di lock e gli impegni completi.
 * Non abilita 'pronto', conferme o Stripe.
 */
import { pool } from '../../db/db.js';
import { verificaTurnoVeicolo } from '../popbus/v2/popbus-vehicle-availability.js';
import { registraAccettazioneProvvisoriaAR } from './ar-acceptance.service.js';
import {
  verificaSovrapposizioniVeicolo,
  verificaTrasferimentiVeicolo
} from './vehicle-commitments.service.js';

function fail(code) {
  const e = new Error(code);
  e.code = code;
  e.status = 409;
  throw e;
}
function positiveInt(x) {
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function point(lat, lon) {
  if (lat == null || lon == null) return null;
  const a = Number(lat), b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) &&
    a >= -90 && a <= 90 && b >= -180 && b <= 180
    ? { lat: a, lon: b } : null;
}

/**
 * Opzione client: transazione gia' aperta, gestita dal chiamante.
 * Senza client: apre e committa la sola accettazione provvisoria.
 * movement e' ammesso per test deterministici, non negli endpoint LIVE.
 */
export async function accettaTrattaARAtomica({
  pendingId, operatoreId, client: externalClient = null,
  movement, routing
} = {}) {
  const pid = positiveInt(pendingId);
  const oid = positiveInt(operatoreId);
  if (!pid || !oid) fail('AR_INVALID_INPUT');
  const ownClient = !externalClient;
  const client = externalClient ?? await pool.connect();
  let tx = false;
  try {
    if (ownClient) {
      await client.query('BEGIN');
      tx = true;
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
    }

    // Ordine locale: gruppo -> veicolo -> disponibilita -> pending.
    // Recupero iniziale NON bloccante; rivalidazione dopo i lock.
    const { rows: initial } = await client.query(`
      SELECT id, ar_group_id, veicolo_id
      FROM pending WHERE id = $1
    `, [pid]);
    if (!initial[0]?.ar_group_id || !positiveInt(initial[0]?.veicolo_id))
      fail('AR_PENDING_NOT_FOUND');
    const groupId = initial[0].ar_group_id;
    const vehicleId = Number(initial[0].veicolo_id);

    const { rows: groups } = await client.query(`
      SELECT id, stato, expires_at FROM ar_gruppi WHERE id = $1 FOR UPDATE
    `, [groupId]);
    const g = groups[0];
    if (!g || !['autorizzato', 'in_attesa'].includes(g.stato) ||
        !(new Date(g.expires_at).getTime() > Date.now()))
      fail('AR_GROUP_NOT_ACCEPTING');

    const { rows: vehicles } = await client.query(`
      SELECT id, driver_id, stato FROM veicolo WHERE id = $1 FOR UPDATE
    `, [vehicleId]);
    const v = vehicles[0];
    if (!v || Number(v.driver_id) !== oid) fail('AR_OPERATOR_NOT_AUTHORIZED');
    // Non equiparare NULL a stato attivo: l'abilitazione LIVE e' da definire.
    if (v.stato != null && !['test', 'attivo'].includes(v.stato))
      fail('AR_VEHICLE_STATUS_BLOCKED');

    const { rows: availability } = await client.query(`
      SELECT start, fine, giorni_esclusi, inattivita
      FROM disponibilita_veicolo WHERE veicolo_id = $1 FOR UPDATE
    `, [vehicleId]);

    const { rows: pendings } = await client.query(`
      SELECT id, veicolo_id, ar_group_id, ar_tratta, ar_vincolata,
             stato, expires_at, start_datetime AS inizio,
             start_datetime + durata AS fine,
             ST_Y(origine::geometry) AS origine_lat,
             ST_X(origine::geometry) AS origine_lon,
             ST_Y(destinazione::geometry) AS destinazione_lat,
             ST_X(destinazione::geometry) AS destinazione_lon
      FROM pending WHERE id = $1 FOR UPDATE
    `, [pid]);
    const p = pendings[0];
    if (!p || p.ar_group_id !== groupId ||
        Number(p.veicolo_id) !== vehicleId ||
        p.ar_vincolata !== true ||
        !['andata', 'ritorno'].includes(p.ar_tratta) ||
        p.stato !== 'pending' ||
        !(new Date(p.expires_at).getTime() > Date.now()))
      fail('AR_PENDING_NOT_AVAILABLE');

    const start = new Date(p.inizio).getTime();
    const end = new Date(p.fine).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      fail('AR_INTERVAL_INVALID');
    if (!availability.some(d => verificaTurnoVeicolo(d, start, end)))
      fail('AR_SHIFT_UNAVAILABLE');

    const origin = point(p.origine_lat, p.origine_lon);
    const destination = point(p.destinazione_lat, p.destinazione_lon);
    if (!origin || !destination) fail('AR_COORDINATES_UNVERIFIED');

    // Una riserva preesistente del medesimo pending e' esclusa soltanto
    // dopo verifica della sua identita'; le altre riserve restano visibili.
    const { rows: existing } = await client.query(`
      SELECT * FROM ar_accettazioni WHERE pending_id = $1 FOR UPDATE
    `, [pid]);
    const old = existing[0];
    if (old && (old.stato !== 'provvisoria' ||
        old.ar_group_id !== groupId ||
        Number(old.veicolo_id) !== vehicleId ||
        !(new Date(old.expires_at).getTime() > Date.now())))
      fail('AR_ACCEPTANCE_ALREADY_EXISTS');
    const escludi = old ? [{ fonte: 'AR_PROVVISORIA', id: old.id }] : [];

    const overlap = await verificaSovrapposizioniVeicolo(
      client, vehicleId, p.inizio, p.fine, { escludi }
    );
    if (!overlap.disponibile || overlap.nonVerificabili?.length)
      fail('AR_VEHICLE_CONFLICT');

    const transfer = await verificaTrasferimentiVeicolo(
      client, vehicleId,
      { inizio: p.inizio, fine: p.fine, origine: origin, destinazione: destination },
      { escludi, movement, routing }
    );
    if (!transfer.compatibile || transfer.nonVerificabili?.length)
      fail('AR_VEHICLE_TRANSFER_UNVERIFIED');

    const accepted = await registraAccettazioneProvvisoriaAR(client, {
      arGroupId: groupId, pendingId: pid, veicoloId: vehicleId
    });
    if (ownClient) {
      await client.query('COMMIT');
      tx = false;
    }
    return {
      ...accepted, gruppoId: groupId, pendingId: pid,
      veicoloId: vehicleId, stato: 'provvisoria',
      soloAccettazioneProvvisoria: true
    };
  } catch (e) {
    if (ownClient && tx) await client.query('ROLLBACK');
    throw e;
  } finally {
    if (ownClient) client.release();
  }
}
