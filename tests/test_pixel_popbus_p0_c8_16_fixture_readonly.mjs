// TURENTU P0-C8.16 — Discovery fixture PIXEL, rigorosamente read-only.
// Rinominare .mjs.txt -> .mjs in tests/. Eseguire: node --env-file=.env tests/test_pixel_popbus_p0_c8_16_fixture_readonly.mjs
import { pool } from '../db/db.js';
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const q = await client.query(`
    SELECT o.id AS opportunita_id, o.stato AS opportunita_stato,
           d.id AS direttrice_id, d.stato AS direttrice_stato,
           d.versione, d.engine_id, d.nodi,
           COALESCE(array_agg(DISTINCT por.richiesta_id ORDER BY por.richiesta_id)
             FILTER (WHERE por.richiesta_id IS NOT NULL), ARRAY[]::integer[]) AS richiesta_ids
    FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id = o.direttrice_id
    LEFT JOIN public.pixel_opportunita_richieste por ON por.opportunita_id = o.id
    WHERE o.stato = 'candidata' AND d.stato = 'attiva'
    GROUP BY o.id, o.stato, d.id, d.stato, d.versione, d.engine_id, d.nodi
    ORDER BY o.id DESC LIMIT 30`);
  console.log('\n=== OPPORTUNITA PIXEL CANDIDATE (max 30) ===');
  for (const o of q.rows) console.log(JSON.stringify(o));
  const ids = [...new Set(q.rows.flatMap(o => o.richiesta_ids.map(Number)))];
  if (ids.length) {
    const r = await client.query(`
      SELECT id, stato, corsa_id, cliente_id, start_datetime, prezzo,
             posti_richiesti, origine_nodo_territoriale_id,
             destinazione_nodo_territoriale_id
      FROM public.richieste_pop_bus WHERE id = ANY($1::int[]) ORDER BY id`, [ids]);
    console.log('\n=== RICHIESTE ASSOCIATE ===');
    for (const x of r.rows) console.log(JSON.stringify(x));
  }
  const v = await client.query(`
    SELECT v.id, v.driver_id, v.posti_totali, v.localita,
           EXISTS (SELECT 1 FROM public.disponibilita_veicolo dv WHERE dv.veicolo_id = v.id) AS turno_configurato,
           (SELECT MIN(t.euro_km) FROM public.tariffe t WHERE t.veicolo_id=v.id AND t.tipo='standard' AND t.euro_km>0) AS euro_km_standard
    FROM public.veicolo v WHERE v.driver_id IS NOT NULL AND v.posti_totali >= 3
    ORDER BY v.id`);
  console.log('\n=== VEICOLI POTENZIALI ===');
  for (const x of v.rows) console.log(JSON.stringify(x));
  console.log('\nESITO: lettura soltanto. Nessuna attivazione, nessuna chiamata Stripe.');
} catch (e) {
  console.error('ERRORE READ-ONLY:', e.message, 'SQLSTATE:', e.code || 'n/d');
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK completato'); }
    catch (e) { console.error('ROLLBACK ERROR:', e.message); process.exitCode = 1; }
    client.release();
  }
  await pool.end();
}
