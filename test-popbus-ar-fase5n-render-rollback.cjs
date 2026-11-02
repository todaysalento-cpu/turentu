'use strict';
// Fase 5N: esegue il finalizzatore reale su una coppia di fixture GIA' PRESENTI.
// Sicurezza: COMMIT vietato, ROLLBACK obbligatorio, solo veicoli 357/358.
// Non crea fixture e non chiama Stripe direttamente.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const root = process.cwd();
  const activationId = Number(process.env.TURENTU_TEST_AR_ACTIVATION_ID);
  if (!Number.isSafeInteger(activationId) || activationId <= 0) {
    throw new Error('Impostare TURENTU_TEST_AR_ACTIVATION_ID con una attivazione di fixture dedicata. Nessuna scrittura eseguita.');
  }
  if (process.env.TURENTU_TEST_AR_CONFIRM !== 'ROLLBACK_ONLY') {
    throw new Error('Richiesta TURENTU_TEST_AR_CONFIRM=ROLLBACK_ONLY.');
  }
  if (process.env.POPBUS_CONDUCENTI_ENABLED === 'true') {
    throw new Error('Disabilitare POPBUS_CONDUCENTI_ENABLED per questo primo collaudo; assegnazioni da testare separatamente.');
  }
  // Utilizza la configurazione DB del progetto, senza copiare credenziali.
  const pg = require(path.join(root, 'node_modules', 'pg'));
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: 1 });
  let client;
  let txOpen = false;
  let commitAttempts = 0;
  let rollbackAttempts = 0;
  let safe = false;
  try {
    client = await pool.connect();
    const originalQuery = client.query.bind(client);
    // Controllo preliminare di sola lettura; nessun client proxy prima del check.
    const check = await originalQuery(`
      SELECT a.id, a.veicolo_id, a.autista_id, a.stato,
             COUNT(DISTINCT r.id)::integer AS n_richieste,
             COUNT(DISTINCT r.ar_group_id)::integer AS n_gruppi,
             BOOL_AND(r.ar_vincolata IS TRUE) AS tutte_ar,
             BOOL_AND(r.payment_intent_id LIKE 'wallet_%') AS tutte_wallet
      FROM popbus_attivazioni a
      LEFT JOIN popbus_attivazione_richieste ar ON ar.attivazione_id=a.id AND ar.attiva
      LEFT JOIN richieste_pop_bus r ON r.id=ar.richiesta_id
      WHERE a.id=$1
      GROUP BY a.id`, [activationId]);
    if (check.rows.length !== 1 || ![357,358].includes(Number(check.rows[0].veicolo_id)) ||
        Number(check.rows[0].autista_id) !== 2 || check.rows[0].stato !== 'in_attesa_autista' ||
        check.rows[0].n_richieste < 1 || check.rows[0].tutte_ar !== true || check.rows[0].tutte_wallet !== true) {
      throw new Error('Fixture root non valida: richiesti veicolo test 357/358, operatore 2, richieste A/R wallet.');
    }
    // Una transazione REALE, ma COMMIT intercettato. Il client non viene mai rilasciato
    // finche' non e' stato eseguito un ROLLBACK reale sul collegamento originale.
    client.query = async (sql, params) => {
      const command = typeof sql === 'string' ? sql.trim().replace(/;$/, '').toUpperCase() : '';
      if (command === 'COMMIT' || command === 'END') {
        commitAttempts++;
        throw new Error('FASE_5N_COMMIT_VIETATO');
      }
      if (command === 'BEGIN' || command.startsWith('BEGIN ')) {
        if (txOpen) throw new Error('Transazione annidata vietata');
        const res = await originalQuery(sql, params);
        txOpen = true;
        return res;
      }
      if (command === 'ROLLBACK') {
        rollbackAttempts++;
        const res = await originalQuery('ROLLBACK');
        txOpen = false;
        return res;
      }
      return originalQuery(sql, params);
    };
    const mockPool = { connect: async () => ({ query: (...args) => client.query(...args), release: () => {} }) };
    const moduleUrl = pathToFileURL(path.join(root, 'services', 'popbus', 'v2', 'acceptance.js')).href;
    const { finalizzaAttivazioniAR } = await import(moduleUrl);
    if (typeof finalizzaAttivazioniAR !== 'function') throw new Error('Finalizzatore non esportato');
    console.log('FASE 5N: avvio conversione reale, COMMIT impossibile tramite client protetto');
    try {
      await finalizzaAttivazioniAR(mockPool, activationId, new Map());
      throw new Error('ERRORE CRITICO: finalizzatore ritornato senza COMMIT');
    } catch (e) {
      console.log('Finalizzatore interrotto:', e.message);
      if (e.message === 'FASE_5N_COMMIT_VIETATO') {
        console.log('PASS: entrambe le conversioni e verifiche hanno raggiunto il COMMIT, bloccato');
      } else {
        console.log('ATTENZIONE: errore prima del COMMIT; controllare se e avvenuto prima o dopo la prima conversione');
      }
    }
    if (txOpen) { await originalQuery('ROLLBACK'); txOpen = false; rollbackAttempts++; }
    const state = await originalQuery(`SELECT id, stato, corsa_id FROM popbus_attivazioni WHERE id=$1`, [activationId]);
    if (state.rows.length !== 1 || state.rows[0].stato !== 'in_attesa_autista' || state.rows[0].corsa_id != null) {
      throw new Error('ATTENZIONE: stato root non conforme dopo rollback; verificare immediatamente');
    }
    safe = true;
    console.log('PASS: attivazione root invariata dopo rollback; COMMIT intercettati:', commitAttempts, 'ROLLBACK:', rollbackAttempts);
    console.log('Nota: la verifica completa delle righe figlie richiede gli ID delle fixture e una query di confronto prima/dopo.');
  } finally {
    if (client) {
      try { if (txOpen) await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK FALLITO:', e.message); }
      client.release(true);
    }
    await pool.end();
    if (!safe) console.error('Test non superato o non completato.');
  }
}
main().catch(e => { console.error('FASE 5N:', e.message); process.exitCode = 1; });
