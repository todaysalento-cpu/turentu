/**
 * TURENTU - POPBUS V2 A/R - FASE 3 (NON COLLEGATO AL ROUTER).
 * Il servizio registra una singola accettazione provvisoria e, se l'intera
 * dipendenza e' pronta, tenta la finalizzazione atomica in una NUOVA transazione.
 * Nessuna cache/notifica viene pubblicata da questo servizio.
 * NON abilitare in produzione prima dei test COMMIT, concorrenza e recovery.
 */
import { pool } from '../../../db/db.js';
import { registraAccettazioneProvvisoriaPopbus } from './popbus-ar-acceptance.service.js';
import { analizzaDipendenzeAR } from './popbus-ar-coordinator.service.js';
import { finalizzaAttivazioniAR } from './acceptance.js';

function errore(message, code = 'POPBUS_AR_INVALID', status = 409) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function idPositivo(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function abilitato() {
  return process.env.POPBUS_AR_FINALIZATION_ENABLED === 'true';
}

/**
 * @param {object} input
 * @param {number} input.attivazioneId
 * @param {number} input.offertaId
 * @param {number} input.operatoreId - da sessione autenticata, MAI dal body HTTP
 * @param {object|null} input.sceltaConducente
 * @returns {Promise<{stato:string, attivazioneId:number, corse?:Array, gruppi?:Array, accettazioneId?:number}>}
 */
export async function accettaOffertaPopbusAR({
  attivazioneId, offertaId, operatoreId, sceltaConducente = null
} = {}) {
  if (!abilitato()) {
    throw errore('Finalizzazione POPBUS A/R non abilitata', 'POPBUS_AR_DISABLED', 503);
  }
  const aid = idPositivo(attivazioneId);
  const oid = idPositivo(offertaId);
  const uid = idPositivo(operatoreId);
  if (!aid || !oid || !uid) {
    throw errore('Identificativi POPBUS A/R non validi', 'POPBUS_AR_BAD_INPUT', 400);
  }

  // 1. Registra e conferma SOLO l'accettazione provvisoria.
  const client = await pool.connect();
  let tx = false;
  let accettazione;
  try {
    await client.query('BEGIN');
    tx = true;
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    // Serializza retry e finalizzazioni con lo stesso lock globale.
    await client.query('SELECT pg_advisory_xact_lock(734021, 1)');
    const { rows: confermate } = await client.query(`
      SELECT p.id AS accettazione_id, p.attivazione_id, p.offerta_id,
             p.veicolo_id, p.stato, p.scelta_conducente, a.corsa_id,
             a.stato AS attivazione_stato, o.stato AS offerta_stato,
             o.autista_id AS operatore_offerta, a.autista_id AS operatore_attivazione,
             v.driver_id AS operatore_veicolo
      FROM popbus_ar_accettazioni p
      JOIN popbus_attivazioni a ON a.id = p.attivazione_id
      JOIN offerte_autisti o ON o.id = p.offerta_id
      JOIN veicolo v ON v.id = a.veicolo_id
      WHERE p.attivazione_id = $1 OR p.offerta_id = $2
      FOR UPDATE OF p, a, o, v
    `, [aid, oid]);
    if (confermate.some(r => r.stato === 'confermata') ||
        confermate.some(r => r.attivazione_stato === 'confermata')) {
      if (confermate.length !== 1) {
        throw errore('Accettazioni A/R incoerenti');
      }
      const r = confermate[0];
      if (Number(r.attivazione_id) !== aid || Number(r.offerta_id) !== oid ||
          Number(r.operatore_offerta) !== uid ||
          Number(r.operatore_attivazione) !== uid ||
          Number(r.operatore_veicolo) !== uid ||
          r.attivazione_stato !== 'confermata' || r.offerta_stato !== 'accettata' ||
          !idPositivo(r.corsa_id)) {
        throw errore('Accettazione A/R confermata incoerente o non autorizzata');
      }
      const { rows: stato } = await client.query(`
        SELECT p.stato, p.scelta_conducente
        FROM popbus_ar_accettazioni p WHERE p.id = $1
      `, [r.accettazione_id]);
      if (stato.length !== 1 || stato[0].stato !== 'confermata') {
        throw errore('Accettazione A/R non confermata');
      }
      // Non fidarsi della sola corsa: tutte le coppie A/R collegate devono
      // risultare convertite e il gruppo definitivamente confermato.
      const { rows: gruppi } = await client.query(`
        SELECT g.id, g.stato,
          COUNT(r.id)::integer AS totale,
          COUNT(*) FILTER (WHERE r.ar_tratta = 'andata' AND r.stato = 'convertita'
            AND r.corsa_id IS NOT NULL)::integer AS andate,
          COUNT(*) FILTER (WHERE r.ar_tratta = 'ritorno' AND r.stato = 'convertita'
            AND r.corsa_id IS NOT NULL)::integer AS ritorni
        FROM ar_gruppi g
        JOIN richieste_pop_bus r ON r.ar_group_id = g.id AND r.ar_vincolata IS TRUE
        WHERE g.id IN (
          SELECT DISTINCT origine.ar_group_id
          FROM popbus_attivazione_richieste par
          JOIN richieste_pop_bus origine ON origine.id = par.richiesta_id
          WHERE par.attivazione_id = $1 AND par.attiva = TRUE
            AND origine.ar_vincolata IS TRUE
        )
        GROUP BY g.id, g.stato
      `, [aid]);
      if (!gruppi.length || gruppi.some(g => g.stato !== 'confermato' ||
          g.totale !== 2 || g.andate !== 1 || g.ritorni !== 1)) {
        throw errore('Coppie A/R non integralmente confermate');
      }
      const sceltaDb = stato[0].scelta_conducente ?? null;
      // Una richiesta duplicata non puo' cambiare una scelta gia' confermata.
      if (process.env.POPBUS_CONDUCENTI_ENABLED === 'true' &&
          sceltaConducente != null) {
        const normalizza = x => x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(Object.keys(x).sort().map(k => [k, normalizza(x[k])]))
          : Array.isArray(x) ? x.map(normalizza) : x;
        const prevista = sceltaConducente.modalita === 'titolare'
          ? { modalita: 'titolare', conducenteId: uid }
          : sceltaConducente.modalita === 'automatica'
            ? { modalita: 'automatica' }
            : { modalita: 'manuale', conducenteId: Number(sceltaConducente.conducenteId),
                confermaDeroga: sceltaConducente.confermaDeroga === true,
                motivoDeroga: sceltaConducente.motivoDeroga ?? null };
        if (JSON.stringify(normalizza(prevista)) !== JSON.stringify(normalizza(sceltaDb))) {
          throw errore('Scelta conducente diversa da quella confermata');
        }
      }
      await client.query('COMMIT');
      tx = false;
      return { stato: 'confermato', attivazioneId: aid,
        giaConfermato: true, accettazioneId: Number(r.accettazione_id),
        corsa_id: Number(r.corsa_id), gruppi: gruppi.map(g => g.id) };
    }
    accettazione = await registraAccettazioneProvvisoriaPopbus(client, {
      attivazioneId: aid,
      offertaId: oid,
      operatoreId: uid,
      sceltaConducente
    });
    await client.query('COMMIT');
    tx = false;
  } catch (e) {
    if (tx) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { e.rollbackError = rollbackError; }
    }
    throw e;
  } finally {
    client.release();
  }

  // 2. Il coordinatore e' una lettura orientativa, NON autorizza conversioni.
  // Il finalizzatore rivalida tutto sotto advisory lock e row locks.
  const lettura = await pool.connect();
  let analisi;
  let readTx = false;
  try {
    await lettura.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    readTx = true;
    analisi = await analizzaDipendenzeAR(lettura, aid);
    await lettura.query('COMMIT');
    readTx = false;
  } catch (e) {
    if (readTx) {
      try { await lettura.query('ROLLBACK'); }
      catch (rollbackError) { e.rollbackError = rollbackError; }
    }
    throw e;
  } finally {
    lettura.release();
  }

  // Una seconda chiamata concorrente puo osservare il gruppo gia convertito.
  // Riconcilia SOLO se la stessa offerta e la stessa attivazione sono confermate.
  // La verifica completa di autorizzazione, gruppo e scelta conducente resta
  // nel ramo idempotente all'inizio di accettaOffertaPopbusAR.
  async function recuperaConfermaConcorrente() {
    const c = await pool.connect();
    try {
      const { rows } = await c.query(`
        SELECT 1
        FROM popbus_ar_accettazioni p
        JOIN popbus_attivazioni a ON a.id = p.attivazione_id
        JOIN offerte_autisti o ON o.id = p.offerta_id
        WHERE p.attivazione_id = $1 AND p.offerta_id = $2
          AND p.stato = 'confermata' AND a.stato = 'confermata'
          AND a.corsa_id IS NOT NULL AND o.stato = 'accettata'
        LIMIT 1
      `, [aid, oid]);
      if (!rows.length) return null;
    } finally {
      c.release();
    }
    return accettaOffertaPopbusAR({ attivazioneId: aid, offertaId: oid,
      operatoreId: uid, sceltaConducente });
  }

  if (analisi.stato === 'non_valida') {
    const conferma = await recuperaConfermaConcorrente();
    if (conferma) return conferma;
    // Se non e' confermata, non mascherare un problema reale.
    throw errore('Dipendenze A/R non valide dopo accettazione provvisoria', 'POPBUS_AR_DEPENDENCIES_INVALID');
  }
  if (analisi.stato === 'in_attesa') {
    return {
      stato: 'in_attesa', attivazioneId: aid,
      accettazioneId: Number(accettazione.id),
      accettazioniMancanti: analisi.accettazioniMancanti ?? []
    };
  }
  if (analisi.stato !== 'pronta') {
    throw errore('Stato coordinatore A/R sconosciuto', 'POPBUS_AR_UNKNOWN_STATE');
  }

  // 3. Il finalizzatore apre una SUA transazione e legge le scelte dal DB.
  // Non passare una Map dal client o dall'orchestratore.
  let risultato;
  try {
    risultato = await finalizzaAttivazioniAR(pool, aid);
  } catch (e) {
    const conferma = await recuperaConfermaConcorrente();
    if (conferma) return conferma;
    throw e;
  }
  if (risultato.stato !== 'confermato' || !Array.isArray(risultato.corse) ||
      risultato.corse.length < 1 ||
      risultato.corse.some(item => !idPositivo(item?.attivazioneId) || !idPositivo(item?.corsa?.id)) ||
      new Set(risultato.corse.map(item => Number(item.attivazioneId))).size !== risultato.corse.length ||
      new Set(risultato.corse.map(item => Number(item.corsa.id))).size !== risultato.corse.length ||
      !risultato.corse.some(item => Number(item.attivazioneId) === aid)) {
    throw errore('Finalizzazione A/R incompleta', 'POPBUS_AR_FINALIZATION_INCOMPLETE');
  }
  return {
    stato: 'confermato', attivazioneId: aid,
    corse: risultato.corse, gruppi: risultato.gruppi
  };
}
