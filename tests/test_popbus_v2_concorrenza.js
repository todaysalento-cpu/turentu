import { pool } from '../db/db.js';

// POPBUS V2: test di concorrenza controllato sul DB attuale.
// Non chiama il worker reale, non invia offerte/socket e non esegue COMMIT.
// Verifica i meccanismi PostgreSQL, NON prova da solo che il worker li usi correttamente.

const VEHICLE_ID = 353;
const DIR_ID = -1900353011;
const ACT_ID = -1900353011;
const START = '2026-10-16T09:00:00.000Z';
const END = '2026-10-16T10:26:18.000Z';
const ADVISORY_NAMESPACE = 1987654321; // Chiave DI TEST, non quella del worker.

function check(ok, message) { if (!ok) throw new Error(message); }

async function begin(client) {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '1500ms'");
  await client.query("SET LOCAL statement_timeout = '8s'");
}
async function rollback(client) { await client.query('ROLLBACK'); }

async function assertNoTestRows(client) {
  const { rows: [r] } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.direttrici_virtuali WHERE id=$1) AS direttrici,
      (SELECT COUNT(*)::int FROM public.popbus_attivazioni WHERE id=$2) AS attivazioni,
      (SELECT COUNT(*)::int FROM public.offerte_autisti WHERE attivazione_id=$2) AS offerte,
      (SELECT COUNT(*)::int FROM public.popbus_attivazione_segmenti WHERE attivazione_id=$2) AS segmenti,
      (SELECT COUNT(*)::int FROM public.popbus_attivazione_richieste WHERE attivazione_id=$2) AS richieste
  `, [DIR_ID, ACT_ID]);
  check(Object.values(r).every(n => n === 0), `Righe di test presenti: ${JSON.stringify(r)}`);
}

async function main() {
  console.log('=== POPBUS V2 | CONCORRENZA TRANSAZIONALE | NO COMMIT ===');
  const a = await pool.connect();
  const b = await pool.connect();
  let txA = false;
  let txB = false;
  try {
    check(a.processID !== b.processID, 'Servono due connessioni PostgreSQL indipendenti');
    await assertNoTestRows(a);
    const { rows: [vehicle] } = await a.query(
      'SELECT id, driver_id FROM public.veicolo WHERE id=$1', [VEHICLE_ID]
    );
    check(vehicle && vehicle.driver_id != null, 'Veicolo 353 o autista mancante');
    const { rows: [nodes] } = await a.query(
      'SELECT COUNT(*)::int AS n FROM public.nodi_direttrice WHERE id IN (13,12)'
    );
    check(nodes.n === 2, 'Nodi 13/12 mancanti');

    // SCENARIO A: advisory lock transazionale serializza l'accesso.
    await begin(a); txA = true;
    await a.query('SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [ADVISORY_NAMESPACE, VEHICLE_ID]);
    console.log('A | lock advisory acquisito');

    await begin(b); txB = true;
    let errB;
    try {
      await b.query('SELECT pg_advisory_xact_lock($1::int, $2::int)',
        [ADVISORY_NAMESPACE, VEHICLE_ID]);
    } catch (e) { errB = e; }
    check(errB?.code === '55P03', `B doveva attendere/scadere con 55P03; ricevuto ${errB?.code || 'nessun errore'}`);
    console.log('B | stesso lock bloccato: 55P03 (PASS)');
    await rollback(b); txB = false;
    await rollback(a); txA = false;

    await begin(b); txB = true;
    await b.query('SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [ADVISORY_NAMESPACE, VEHICLE_ID]);
    console.log('B | lock acquisito dopo rilascio di A (PASS)');
    await rollback(b); txB = false;

    // SCENARIO B: row lock FOR UPDATE su veicolo.
    await begin(a); txA = true;
    await a.query('SELECT id FROM public.veicolo WHERE id=$1 FOR UPDATE', [VEHICLE_ID]);
    await begin(b); txB = true;
    let rowErr;
    try {
      await b.query('SELECT id FROM public.veicolo WHERE id=$1 FOR UPDATE NOWAIT', [VEHICLE_ID]);
    } catch (e) { rowErr = e; }
    check(rowErr?.code === '55P03', `Atteso NOWAIT 55P03; ricevuto ${rowErr?.code || 'nessun errore'}`);
    console.log('B | lock riga veicolo negato: 55P03 (PASS)');
    await rollback(b); txB = false;
    await rollback(a); txA = false;

    await begin(b); txB = true;
    const { rows: unlocked } = await b.query(
      'SELECT id FROM public.veicolo WHERE id=$1 FOR UPDATE NOWAIT', [VEHICLE_ID]
    );
    check(unlocked.length === 1, 'Veicolo non bloccabile dopo rollback A');
    console.log('B | lock riga acquisito dopo rollback A (PASS)');
    await rollback(b); txB = false;

    // SCENARIO C: una transazione vede i propri INSERT, l'altra non li vede.
    // Usa ID negativi, senza avanzare le sequenze; nessuna richiesta reale.
    await begin(a); txA = true;
    await a.query(`INSERT INTO public.direttrici_virtuali
      (id,stato,partenza_prevista,start_node_id,end_node_id,tipo_servizio)
      VALUES ($1,'in_formazione',$2,13,12,'STANDARD_V2')`, [DIR_ID, START]);
    await a.query(`INSERT INTO public.popbus_attivazioni
      (id,direttrice_id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
      VALUES ($1,$2,$3,$4,'in_attesa_autista',$5,$6,117,135,0.60,$7::jsonb,$8)`,
      [ACT_ID, DIR_ID, VEHICLE_ID, vehicle.driver_id, START, END,
       JSON.stringify({ testOnly: true, nodes: [13, 11, 12] }), START]);
    const { rows: [seenA] } = await a.query(
      'SELECT COUNT(*)::int AS n FROM public.popbus_attivazioni WHERE id=$1', [ACT_ID]);
    check(seenA.n === 1, 'A non vede il proprio INSERT');
    const { rows: [seenB] } = await b.query(
      'SELECT COUNT(*)::int AS n FROM public.popbus_attivazioni WHERE id=$1', [ACT_ID]);
    check(seenB.n === 0, 'B vede righe non confermate di A');
    console.log('A vede INSERT; B non vede INSERT non confermato (PASS)');
    await rollback(a); txA = false;
    await assertNoTestRows(b);
    console.log('ROLLBACK e verifica seconda connessione: PASS');
    console.log('ESITO FINALE: PASS');
  } finally {
    if (txB) { try { await rollback(b); } catch (e) { console.error('Rollback B fallito:', e.message); } }
    if (txA) { try { await rollback(a); } catch (e) { console.error('Rollback A fallito:', e.message); } }
    a.release(); b.release();
    await pool.end();
  }
}

main().catch(e => { console.error('ESITO FINALE: FAIL', e.code || '', e.message); process.exitCode = 1; });
