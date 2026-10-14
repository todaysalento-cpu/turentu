import { pool } from '../db/db.js';

// Test transazionale isolato: nessun worker, nessun socket, nessuna offerta.
const VEHICLE_ID = 353;
const START = '2026-10-16T09:00:00.000Z';
const MID = '2026-10-16T09:54:36.000Z';
const END = '2026-10-16T10:26:18.000Z';
const BUSY_END = '2026-10-16T11:41:28.000Z';
const TABLES = [
  ['direttrici_virtuali', 'id'],
  ['segmenti', 'id'],
  ['popbus_attivazioni', 'id'],
  ['popbus_attivazione_segmenti', 'attivazione_id'],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkOutside(ids) {
  const reader = await pool.connect();
  try {
    const queries = [
      ['direttrici_virtuali', 'id', [ids.dir]],
      ['segmenti', 'id', [ids.seg1, ids.seg2]],
      ['popbus_attivazioni', 'id', [ids.act]],
      ['popbus_attivazione_segmenti', 'attivazione_id', [ids.act]],
    ];
    for (const [table, col, values] of queries) {
      const { rows } = await reader.query(`SELECT COUNT(*)::int AS n FROM public.${table} WHERE ${col} = ANY($1::bigint[])`, [values]);
      assert(rows[0].n === 0, `Persistenza inattesa in ${table}: ${rows[0].n}`);
    }
  } finally {
    reader.release();
  }
}

async function main() {
  console.log('=== POPBUS V2 | TRANSAZIONI E ROLLBACK ===');
  const client = await pool.connect();
  let inTx = false;
  let ids;
  try {
    // Riserva soltanto un intervallo di ID negativi, senza usare nextval().
    // Le tabelle hanno ID integer/bigint, ma le FK e i check continuano a valere.
    ids = { dir: -1900353001, seg1: -1900353001, seg2: -1900353002, act: -1900353001 };
    await checkOutside(ids);
    const { rows: v } = await client.query('SELECT id, driver_id, posti_totali FROM public.veicolo WHERE id=$1', [VEHICLE_ID]);
    assert(v.length === 1 && v[0].driver_id != null && Number(v[0].posti_totali) >= 9, 'Veicolo 353 non idoneo');
    const { rows: n } = await client.query('SELECT id FROM public.nodi_direttrice WHERE id = ANY($1::int[])', [[13, 11, 12]]);
    assert(n.length === 3, 'Nodi 13, 11, 12 mancanti');

    // SCENARIO A: integrità completa, visibile soltanto all'interno della transazione.
    await client.query('BEGIN'); inTx = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(`INSERT INTO public.direttrici_virtuali (id, stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
      VALUES ($1,'in_formazione',$2,13,12,'STANDARD_V2')`, [ids.dir, START]);
    await client.query(`INSERT INTO public.segmenti (id,direttrice_id,start_node_id,end_node_id,ordine_sequenziale,tempo_stimato,start_datetime,stato)
      VALUES ($1,$3,13,11,1,55,$4,'in_attesa'),($2,$3,11,12,2,32,$5,'in_attesa')`,
      [ids.seg1, ids.seg2, ids.dir, START, MID]);
    await client.query(`INSERT INTO public.popbus_attivazioni
      (id,direttrice_id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
      VALUES ($1,$2,$3,$4,'in_attesa_autista',$5,$6,117,135,0.60,$7::jsonb,$8)`,
      [ids.act, ids.dir, VEHICLE_ID, v[0].driver_id, START, END,
        JSON.stringify({ nodes: [13,11,12], busyStart: START, busyEnd: BUSY_END, testOnly: true }), START]);
    await client.query(`INSERT INTO public.popbus_attivazione_segmenti (attivazione_id,segmento_id,ordine)
      VALUES ($1,$2,1),($1,$3,2)`, [ids.act, ids.seg1, ids.seg2]);
    const { rows: inside } = await client.query(`SELECT
      (SELECT COUNT(*)::int FROM public.direttrici_virtuali WHERE id=$1) AS dir,
      (SELECT COUNT(*)::int FROM public.segmenti WHERE direttrice_id=$1) AS seg,
      (SELECT COUNT(*)::int FROM public.popbus_attivazioni WHERE id=$2) AS act,
      (SELECT COUNT(*)::int FROM public.popbus_attivazione_segmenti WHERE attivazione_id=$2) AS links`, [ids.dir, ids.act]);
    assert(inside[0].dir === 1 && inside[0].seg === 2 && inside[0].act === 1 && inside[0].links === 2,
      `Conteggi interni inattesi: ${JSON.stringify(inside[0])}`);
    console.log('Scenario A | dentro la transazione:', inside[0]);
    await client.query('ROLLBACK'); inTx = false;
    await checkOutside(ids);
    console.log('Scenario A | ROLLBACK: PASS (nessuna riga persistente)');

    // SCENARIO B: violazione intenzionale di UNIQUE (attivazione_id, ordine).
    // Non usa richieste reali e non tocca la tabella delle prenotazioni.
    await client.query('BEGIN'); inTx = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(`INSERT INTO public.direttrici_virtuali (id,stato,partenza_prevista,start_node_id,end_node_id,tipo_servizio)
      VALUES ($1,'in_formazione',$2,13,12,'STANDARD_V2')`, [ids.dir, START]);
    await client.query(`INSERT INTO public.segmenti (id,direttrice_id,start_node_id,end_node_id,ordine_sequenziale,tempo_stimato,start_datetime,stato)
      VALUES ($1,$3,13,11,1,55,$4,'in_attesa'),($2,$3,11,12,2,32,$5,'in_attesa')`,
      [ids.seg1, ids.seg2, ids.dir, START, MID]);
    await client.query(`INSERT INTO public.popbus_attivazioni
      (id,direttrice_id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
      VALUES ($1,$2,$3,$4,'in_attesa_autista',$5,$6,117,135,0.60,$7::jsonb,$8)`,
      [ids.act, ids.dir, VEHICLE_ID, v[0].driver_id, START, END,
        JSON.stringify({ nodes: [13,11,12], testOnly: true }), START]);
    await client.query(`INSERT INTO public.popbus_attivazione_segmenti (attivazione_id,segmento_id,ordine)
      VALUES ($1,$2,1)`, [ids.act, ids.seg1]);
    let expectedError = null;
    try {
      await client.query(`INSERT INTO public.popbus_attivazione_segmenti (attivazione_id,segmento_id,ordine)
        VALUES ($1,$2,1)`, [ids.act, ids.seg2]);
    } catch (err) { expectedError = err; }
    assert(expectedError?.code === '23505', `Atteso errore UNIQUE 23505, ricevuto: ${expectedError?.code ?? 'nessuno'}`);
    console.log('Scenario B | violazione UNIQUE rilevata:', expectedError.code);
    await client.query('ROLLBACK'); inTx = false;
    await checkOutside(ids);
    console.log('Scenario B | ROLLBACK: PASS (nessuna riga persistente)');
    console.log('ESITO FINALE: PASS');
  } finally {
    if (inTx) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK di sicurezza eseguito'); }
      catch (e) { console.error('ROLLBACK di sicurezza fallito:', e.message); }
    }
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('FAIL:', err); process.exitCode = 1; });
