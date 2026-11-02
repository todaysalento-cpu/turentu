'use strict';
// Preflight READ ONLY prima del collaudo COMMIT reale su corse_db.
const { Client } = require('pg');
const assert = require('node:assert/strict');
(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL assente');
  assert.notEqual(process.env.POPBUS_AR_FINALIZATION_ENABLED, 'true', 'Feature flag deve restare OFF nel servizio');
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.TURENTU_RENDER_SSL_DIAGNOSTIC === '1' ? {rejectUnauthorized:false} : {rejectUnauthorized:true},
    connectionTimeoutMillis: 15000,
    application_name: 'turentu_ar_commit_preflight_readonly'
  });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout = '10000ms'");
    const id = await db.query('SELECT current_database() AS db, current_user AS usr');
    assert.equal(id.rows[0].db, 'corse_db', 'Database inatteso');
    console.log('PASS: database corse_db');
    const vehicles = await db.query('SELECT id,driver_id,stato,posti_totali FROM veicolo WHERE id=ANY($1::int[]) ORDER BY id', [[357,358]]);
    assert.equal(vehicles.rowCount, 2, 'Veicoli fixture 357/358 assenti');
    assert.ok(vehicles.rows.every(v=>v.stato==='test' && Number(v.driver_id)===2 && Number(v.posti_totali)>0), 'Veicoli fixture non piu idonei');
    console.log('PASS: veicoli test 357/358, operatore 2');
    const tables=['utente','ar_gruppi','richieste_pop_bus','transazioni_wallet','popbus_attivazioni','popbus_attivazione_richieste','offerte_autisti','popbus_ar_accettazioni','corse','prenotazioni','pagamenti'];
    const exists=await db.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])',[tables]);
    assert.equal(exists.rowCount,tables.length,'Tabelle richieste mancanti');
    const cols=await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='popbus_ar_accettazioni'");
    assert.ok(cols.rows.some(r=>r.column_name==='scelta_conducente'),'Colonna scelta_conducente mancante');
    console.log('PASS: schema A/R e tabella di persistenza conducenti');
    const refs=await db.query(`SELECT conrelid::regclass::text AS tabella_figlia,
      confrelid::regclass::text AS tabella_padre, conname AS vincolo,
      pg_get_constraintdef(oid) AS definizione
      FROM pg_constraint WHERE contype='f'
        AND (conrelid=ANY($1::text[]::regclass[]) OR confrelid=ANY($1::text[]::regclass[]))
      ORDER BY tabella_padre,tabella_figlia`,[tables]);
    console.log('VINCOLI FK (per progettare cleanup senza CASCADE):');
    for(const r of refs.rows) console.log(`  ${r.tabella_figlia} -> ${r.tabella_padre}: ${r.vincolo}`);
    const indexes=await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='popbus_ar_accettazioni' ORDER BY indexname");
    console.log('INDICI ACCETTAZIONI:');
    for(const r of indexes.rows) console.log(`  ${r.indexname}: ${r.indexdef}`);
    await db.query('ROLLBACK');
    console.log('PASS: preflight concluso senza scritture o COMMIT');
  } catch(e) {
    await db.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally {await db.end();}
})().catch(e=>{console.error('STOP:',e.message);process.exitCode=1;});
