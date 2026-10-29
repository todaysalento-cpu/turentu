/**
 * TURENTU — A/R STEP 4.32
 * Verifica transazionale PRELIMINARE: non accetta, non conferma,
 * non aggiorna stati e non cattura Stripe.
 *
 * Un client esterno deve essere gia' in transazione; il chiamante
 * ne gestisce COMMIT/ROLLBACK. Senza client esterno, questa funzione
 * apre una transazione propria e termina sempre con ROLLBACK.
 *
 * ATTENZIONE: il risultato non certifica il ciclo operativo completo
 * NCC/POPBUS e NON autorizza il passaggio a 'pronto'.
 */
import { pool } from '../../db/db.js';
import { getArGroupForUpdate } from './ar-coordinator.service.js';
import { verificaCoppiaAR } from './ar-acceptance.service.js';
import {
  bloccaVeicoloPerAssegnazione,
  verificaSovrapposizioniVeicolo,
  verificaTrasferimentiVeicolo
} from './vehicle-commitments.service.js';
import { calcolaTrasferimentoVeicolo } from './vehicle-routing.service.js';

function punto(lat, lon) {
  if (lat == null || lon == null) return null;
  const a = Number(lat), b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b) ||
      a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lon: b };
}

/** Verifica esclusivamente la compatibilita' reciproca delle due tratte. */
export async function verificaCompatibilitaTratteAR(
  client, andataPendingId, ritornoPendingId, options = {}
) {
  const aId = Number(andataPendingId);
  const rId = Number(ritornoPendingId);
  if (!Number.isSafeInteger(aId) || !Number.isSafeInteger(rId) ||
      aId <= 0 || rId <= 0 || aId === rId) {
    throw new Error('AR_LEGS_INVALID');
  }

  const { rows } = await client.query(`
    SELECT id, veicolo_id,
           start_datetime AS inizio,
           start_datetime + durata AS fine,
           ST_Y(origine::geometry) AS origine_lat,
           ST_X(origine::geometry) AS origine_lon,
           ST_Y(destinazione::geometry) AS destinazione_lat,
           ST_X(destinazione::geometry) AS destinazione_lon
    FROM pending WHERE id IN ($1, $2)
  `, [aId, rId]);
  if (rows.length !== 2) throw new Error('AR_LEGS_NOT_FOUND');
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const andata = byId.get(aId), ritorno = byId.get(rId);
  if (!andata || !ritorno) throw new Error('AR_LEGS_INVALID');

  const ia = new Date(andata.inizio).getTime();
  const fa = new Date(andata.fine).getTime();
  const ir = new Date(ritorno.inizio).getTime();
  const fr = new Date(ritorno.fine).getTime();
  if (![ia, fa, ir, fr].every(Number.isFinite) || ia >= fa || ir >= fr) {
    return { compatibile: false, motivo: 'AR_INTERVAL_INVALID' };
  }
  if (Number(andata.veicolo_id) !== Number(ritorno.veicolo_id)) {
    return { compatibile: true, motivo: 'VEICOLI_DIFFERENTI' };
  }
  if (ia < fr && ir < fa) {
    return { compatibile: false, motivo: 'AR_SOVRAPPOSIZIONE' };
  }

  const prima = ia <= ir ? andata : ritorno;
  const dopo = prima === andata ? ritorno : andata;
  const origine = punto(prima.destinazione_lat, prima.destinazione_lon);
  const destinazione = punto(dopo.origine_lat, dopo.origine_lon);
  if (!origine || !destinazione) {
    return { compatibile: false, motivo: 'AR_COORDINATE_MANCANTI' };
  }

  try {
    const movement = options.movement ?? calcolaTrasferimentoVeicolo;
    const percorso = await movement(origine, destinazione, options.routing ?? {});
    if (!Number.isFinite(percorso?.seconds) || percorso.seconds < 0) {
      return { compatibile: false, motivo: 'AR_ROUTING_NON_VERIFICABILE' };
    }
    const disponibiliMs = new Date(dopo.inizio) - new Date(prima.fine);
    const necessariMs = percorso.seconds * 1000;
    if (!Number.isFinite(necessariMs)) {
      return { compatibile: false, motivo: 'AR_ROUTING_NON_VERIFICABILE' };
    }
    return {
      compatibile: necessariMs <= disponibiliMs,
      motivo: necessariMs <= disponibiliMs
        ? 'AR_COMPATIBILE' : 'AR_TRASFERIMENTO_IMPOSSIBILE',
      minutiDisponibili: disponibiliMs / 60000,
      minutiNecessari: necessariMs / 60000
    };
  } catch {
    return { compatibile: false, motivo: 'AR_ROUTING_NON_VERIFICABILE' };
  }
}

/** Verifica A/R sotto blocchi; sempre sola lettura applicativa. */
export async function verificaGruppoARTransazionale(arGroupId, options = {}) {
  const esterno = options.client != null;
  const client = options.client ?? await pool.connect();
  let transazioneAperta = false;
  try {
    if (!esterno) {
      await client.query('BEGIN');
      transazioneAperta = true;
    }
    // In una transazione esterna, non modificare i timeout del chiamante.
    if (!esterno) {
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
    }

    const gruppo = await getArGroupForUpdate(client, arGroupId);
    if (!['in_attesa', 'pronto'].includes(gruppo.stato)) {
      throw new Error('AR_GROUP_STATE_INVALID');
    }
    if (new Date(gruppo.expires_at).getTime() <= Date.now()) {
      throw new Error('AR_GROUP_EXPIRED');
    }

    const coppia = await verificaCoppiaAR(client, arGroupId);
    if (!coppia.completa) {
      return { verificato: false, motivo: coppia.motivo,
        gruppoId: arGroupId, soloControlloPreliminare: true };
    }

    const tratte = [coppia.andata, coppia.ritorno];
    const veicoli = [...new Set(tratte.map(t => Number(t.veicolo_id)))].sort((a, b) => a - b);
    for (const veicoloId of veicoli) {
      await bloccaVeicoloPerAssegnazione(client, veicoloId);
    }

    const compatibilitaTratte = await verificaCompatibilitaTratteAR(
      client, coppia.andata.pending_id, coppia.ritorno.pending_id,
      { movement: options.movement, routing: options.routing }
    );

    const verifiche = [];
    for (const tratta of tratte) {
      const { rows } = await client.query(`
        SELECT id, veicolo_id, start_datetime AS inizio,
               start_datetime + durata AS fine,
               ST_Y(origine::geometry) AS origine_lat,
               ST_X(origine::geometry) AS origine_lon,
               ST_Y(destinazione::geometry) AS destinazione_lat,
               ST_X(destinazione::geometry) AS destinazione_lon
        FROM pending WHERE id = $1
      `, [tratta.pending_id]);
      const p = rows[0];
      if (!p) throw new Error('AR_PENDING_NOT_FOUND');
      const escludi = [{ fonte: 'AR_PROVVISORIA', id: tratta.accettazione_id }];
      const sovrapposizioni = await verificaSovrapposizioniVeicolo(
        client, p.veicolo_id, p.inizio, p.fine, { escludi }
      );
      const origine = punto(p.origine_lat, p.origine_lon);
      const destinazione = punto(p.destinazione_lat, p.destinazione_lon);
      let trasferimenti = { compatibile: false, motivo: 'AR_COORDINATE_MANCANTI' };
      if (origine && destinazione) {
        trasferimenti = await verificaTrasferimentiVeicolo(
          client, p.veicolo_id,
          { inizio: p.inizio, fine: p.fine, origine, destinazione },
          { escludi, movement: options.movement, routing: options.routing }
        );
      }
      verifiche.push({
        tratta: tratta.ar_tratta,
        veicoloId: p.veicolo_id,
        disponibile: sovrapposizioni.disponibile,
        conflitti: sovrapposizioni.conflitti,
        nonVerificabili: sovrapposizioni.nonVerificabili,
        trasferimenti
      });
    }

    return {
      verificato: compatibilitaTratte.compatibile &&
        verifiche.every(v => v.disponibile && v.trasferimenti.compatibile),
      gruppoId: arGroupId,
      verifiche,
      compatibilitaTratte,
      soloControlloPreliminare: true
    };
  } finally {
    if (!esterno) {
      try {
        if (transazioneAperta) await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
  }
}
