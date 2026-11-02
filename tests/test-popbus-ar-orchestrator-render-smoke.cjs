'use strict';
// FASE 3: smoke test dell'orchestratore sul DB Render, rigorosamente READ ONLY.
// Non attiva flag, non registra accettazioni e non modifica dati.
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { Client } = require('pg');

(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL mancante');
  assert.notEqual(process.env.POPBUS_AR_FINALIZATION_ENABLED, 'true', 'STOP: flag A/R attiva; test richiede OFF');
  process.env.POPBUS_AR_FINALIZATION_ENABLED = 'false';
  const { accettaOffertaPopbusAR } = await import(pathToFileURL(resolve('services/popbus/v2/popbus-ar-orchestrator.service.js')).href);
  assert.equal(typeof accettaOffertaPopbusAR, 'function');
  let blocked = false;
  try {
    await accettaOffertaPopbusAR({attivazioneId:1,offertaId:1,operatoreId:1});
  } catch(e) {
    assert.equal(e.code, 'POPBUS_AR_DISABLED', `Errore inatteso: ${e.message}`);
    blocked = true;
  }
  assert.ok(blocked, 'Flag OFF non ha bloccato orchestratore');
  console.log('PASS: feature flag OFF blocca l’orchestratore prima di ogni scrittura');

  const ssl = process.env.TURENTU_RENDER_SSL_DIAGNOSTIC === '1'
    ? {rejectUnauthorized:false} : {rejectUnauthorized:true};
  const db = new Client({connectionString:process.env.DATABASE_URL, ssl, connectionTimeoutMillis:15000, application_name:'turentu_ar_fase3_readonly_smoke'});
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout = '10000ms'");
    const identity = await db.query('SELECT current_database() AS db, current_user AS usr');
    assert.equal(identity.rows[0].db, 'corse_db', 'Database inatteso');
    const columns = await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='popbus_ar_accettazioni'
        AND column_name IN ('attivazione_id','offerta_id','veicolo_id','stato','expires_at','scelta_conducente')`);
    const names = new Set(columns.rows.map(x=>x.column_name));
    for(const required of ['attivazione_id','offerta_id','veicolo_id','stato','expires_at','scelta_conducente']) {
      assert.ok(names.has(required), `Colonna mancante: ${required}`);
    }
    console.log('PASS: Render corse_db, schema accettazioni A/R e scelta_conducente verificati');
    await db.query('ROLLBACK');
    console.log('PASS: nessun COMMIT e nessuna scrittura');
  } catch(e) {
    await db.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally {
    await db.end();
  }
})().catch(e=>{console.error('STOP:',e.message);process.exitCode=1;});
