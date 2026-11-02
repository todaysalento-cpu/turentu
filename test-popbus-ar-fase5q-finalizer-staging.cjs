'use strict';
// Fase 5Q: harness per finalizzatore reale su DB STAGING ISOLATO.
// NON crea fixture; richiede due attivazioni sintetiche gia' predisposte.
// NON USARE sul DB Render di produzione.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');

const fail = m => { throw new Error('5Q SAFETY: ' + m); };
const root = Number(process.env.TURENTU_TEST_AR_ACTIVATION_ID);
const url = process.env.TURENTU_TEST_DATABASE_URL;
if (process.env.TURENTU_TEST_AR_CONFIRM !== 'ROLLBACK_ONLY') fail('manca ROLLBACK_ONLY');
if (!Number.isSafeInteger(root) || root <= 0) fail('ID fixture numerico obbligatorio');
if (!url) fail('TURENTU_TEST_DATABASE_URL obbligatoria (NON DATABASE_URL)');
const parsed = new URL(url);
const dbname = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
if (!/(?:^|[_-])(test|staging|sandbox)(?:$|[_-])/i.test(dbname)) fail('database non identificato come test/staging/sandbox');
if (process.env.POPBUS_CONDUCENTI_ENABLED === 'true') fail('test non predisposto per assegnazione conducenti');
if (process.env.STRIPE_SECRET_KEY && !/^sk_test_/.test(process.env.STRIPE_SECRET_KEY)) fail('Stripe live non consentito');

async function main() {
  const client = new Client({connectionString:url});
  await client.connect();
  let inTx = false;
  let reachedCommit = false;
  try {
    const identity = await client.query('SELECT current_database() AS db, current_user AS usr, pg_is_in_recovery() AS replica');
    console.log('Database STAGING:', identity.rows[0].db);
    await client.query('BEGIN'); inTx = true;
    const group = await client.query(`
      SELECT a.id, a.veicolo_id, a.stato, a.pixel_opportunita_id,
             COUNT(DISTINCT r.id)::int AS requests,
             COUNT(DISTINCT r.id) FILTER (WHERE r.ar_vincolata AND r.payment_intent_id LIKE 'wallet_%')::int AS wallet_ar
      FROM popbus_attivazioni a
      LEFT JOIN popbus_attivazione_richieste ar ON ar.attivazione_id=a.id AND ar.attiva
      LEFT JOIN richieste_pop_bus r ON r.id=ar.richiesta_id
      WHERE a.id=$1 GROUP BY a.id`, [root]);
    if (group.rowCount !== 1 || group.rows[0].requests < 1 || group.rows[0].wallet_ar !== group.rows[0].requests) fail('radice non fixture wallet A/R valida');
    // In questo harness non e' possibile garantire isolamento transitivo solo dalla radice.
    // Il coordinatore reale ricostruisce tutte le dipendenze, poi le verifichiamo.
    const { analizzaDipendenzeAR } = await import(pathToFileURL(path.resolve('services/popbus/v2/popbus-ar-coordinator.service.js')).href);
    const analysis = await analizzaDipendenzeAR(client, root);
    if (analysis.stato !== 'pronta' || analysis.attivazioni.length !== 2 || analysis.gruppi.length !== 1) fail('richiesta coppia A/R pronta con esattamente 2 attivazioni e 1 gruppo: ' + JSON.stringify(analysis.anomalie));
    const ids = analysis.attivazioni;
    const rows = await client.query(`
      SELECT a.id, a.veicolo_id, a.stato, a.pixel_opportunita_id,
             COUNT(r.id)::int AS requests,
             COUNT(r.id) FILTER (WHERE r.ar_vincolata AND r.payment_intent_id LIKE 'wallet_%')::int AS wallet_ar
      FROM popbus_attivazioni a
      JOIN popbus_attivazione_richieste ar ON ar.attivazione_id=a.id AND ar.attiva
      JOIN richieste_pop_bus r ON r.id=ar.richiesta_id
      WHERE a.id=ANY($1::bigint[]) GROUP BY a.id ORDER BY a.id`, [ids]);
    if (rows.rowCount !== 2 || rows.rows.some(r => ![357,358].includes(Number(r.veicolo_id)) || r.stato !== 'in_attesa_autista' || r.requests !== r.wallet_ar || r.requests < 1)) fail('dipendenze non isolate sui veicoli test 357/358 e wallet');
    if (new Set(rows.rows.map(r=>Number(r.veicolo_id))).size !== 2) fail('veicoli test non distinti');
    const gr = analysis.gruppi[0];
    if (gr.richieste.length !== 2 || gr.richieste.some(r=>!ids.includes(Number(r.attivazioneId)))) fail('gruppo A/R non isolato');
    console.log('PASS preflight fixture isolata:', JSON.stringify({ids, gruppo:gr.id, veicoli:rows.rows.map(r=>r.veicolo_id)}));
    // Si arresta intenzionalmente qui: il finalizzatore possiede BEGIN/COMMIT,
    // quindi richiede un adattatore transazionale verificato e un database disposable.
    console.log('GATE 5Q SUPERATO: dipendenze pronte. Finalizzazione NON eseguita.');
  } finally {
    if (inTx) { try { await client.query('ROLLBACK'); console.log('ROLLBACK OK'); } catch(e) { console.error('ROLLBACK FALLITO',e.message); process.exitCode=2; } }
    await client.end();
  }
}
main().catch(e=>{ console.error('STOP SICURO:',e.message); process.exitCode=1; });
