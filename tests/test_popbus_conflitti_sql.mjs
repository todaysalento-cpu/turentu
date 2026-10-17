/**
 * TURENTU POPBUS — verifica conflitti SQL REALI (SOLA LETTURA)
 * Salva come: tests/test_popbus_conflitti_sql.mjs
 * Esegui: node --env-file=.env tests/test_popbus_conflitti_sql.mjs
 * Opzionale CMD: set POPBUS_TEST_VEICOLO_ID=353
 *
 * Riutilizza ESATTAMENTE il pool PostgreSQL del backend (db/db.js).
 * Non importa il worker, non avvia cron, non crea corse.
 * Tutte le query sono eseguite in una transazione READ ONLY e terminano con ROLLBACK.
 */
import { pool } from '../db/db.js';

const id = Number(process.env.POPBUS_TEST_VEICOLO_ID || 353);
if (!Number.isSafeInteger(id) || id <= 0) {
  console.error('FAIL: POPBUS_TEST_VEICOLO_ID deve essere un intero positivo');
  process.exitCode = 1;
} else {
  let client;
  let began = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    began = true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    const identity = await client.query(`
      SELECT current_database() AS database, current_user AS utente,
             current_setting('transaction_read_only') AS sola_lettura,
             current_setting('TimeZone') AS timezone
    `);
    console.log('=== TURENTU POPBUS / CONFLITTI SQL (READ ONLY) ===');
    console.log('Connessione:', identity.rows[0]);
    console.log('Veicolo:', id);

    // Controllo schema: evitare di scambiare una tabella mancante per assenza di conflitti.
    const expected = {
      popbus_attivazioni: ['id','veicolo_id','stato','piano','partenza','arrivo','corsa_id','direttrice_id'],
      corse: ['id','veicolo_id','stato','start_datetime','arrivo_datetime'],
      direttrici_virtuali: ['id','veicolo_id','stato','partenza_prevista'],
      segmenti: ['direttrice_id','start_datetime','tempo_stimato']
    };
    const schema = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY($1::text[])
    `, [Object.keys(expected)]);
    const found = new Map();
    for (const row of schema.rows) {
      if (!found.has(row.table_name)) found.set(row.table_name, new Set());
      found.get(row.table_name).add(row.column_name);
    }
    const missing = [];
    for (const [table, cols] of Object.entries(expected)) {
      for (const col of cols) if (!found.get(table)?.has(col)) missing.push(`${table}.${col}`);
    }
    if (missing.length) {
      throw new Error(`Schema incompatibile, colonne mancanti: ${missing.join(', ')}`);
    }
    console.log('PASS: schema minimo richiesto dalla query verificato');

    const vehicle = await client.query('SELECT id, driver_id FROM public.veicolo WHERE id=$1', [id]);
    console.log('Veicolo DB:', vehicle.rows[0] || '(non presente)');
    if (!vehicle.rows.length) console.warn('AVVISO: il veicolo scelto non esiste nel DB.');

    // Query fedele alla logica conflittiVeicolo() del worker analizzata.
    // Inizio e fine sono inclusivi/esclusivi: [inizio, fine).
    const conflictsSQL = `
      SELECT 'attivazione' AS origine, a.id::text AS id,
        COALESCE((a.piano->>'busyStart')::timestamptz, a.partenza) AS inizio,
        COALESCE((a.piano->>'busyEnd')::timestamptz, a.arrivo) AS fine
      FROM public.popbus_attivazioni a
      WHERE a.veicolo_id=$1
        AND a.stato IN ('in_attesa_autista','confermata')
        AND COALESCE((a.piano->>'busyStart')::timestamptz, a.partenza) < $3::timestamptz
        AND COALESCE((a.piano->>'busyEnd')::timestamptz, a.arrivo) > $2::timestamptz
      UNION ALL
      SELECT 'corsa' AS origine, c.id::text AS id,
        c.start_datetime AS inizio, c.arrivo_datetime AS fine
      FROM public.corse c
      WHERE c.veicolo_id=$1
        AND c.stato IN ('prenotabile','in_corso','da_attivare')
        AND c.start_datetime < $3::timestamptz
        AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime > $2::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM public.popbus_attivazioni a
          WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id
            AND a.stato IN ('in_attesa_autista','confermata')
        )
      UNION ALL
      SELECT 'direttrice' AS origine, d.id::text AS id,
        d.partenza_prevista AS inizio,
        MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute') AS fine
      FROM public.direttrici_virtuali d
      JOIN public.segmenti s ON s.direttrice_id=d.id
      WHERE d.veicolo_id=$1
        AND d.stato IN ('in_attesa_autista','attivo','confermata')
        AND d.partenza_prevista < $3::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM public.popbus_attivazioni a
          WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id
            AND a.stato IN ('in_attesa_autista','confermata')
        )
      GROUP BY d.id,d.partenza_prevista
      HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute') > $2::timestamptz
    `;

    // Due finestre: una futura per il collaudo e una corrente per diagnosi.
    // Tutti i confronti vengono effettuati dal server come timestamptz.
    const now = new Date();
    const windows = [
      { nome: 'ORA + 4 ORE', start: now, end: new Date(now.getTime() + 4*3600000) },
      { nome: '19 OTTOBRE 2026 08:00–14:00 UTC', start: new Date('2026-10-19T08:00:00Z'), end: new Date('2026-10-19T14:00:00Z') }
    ];
    for (const w of windows) {
      const r = await client.query(conflictsSQL, [id, w.start, w.end]);
      console.log(`\n=== FINESTRA ${w.nome} ===`);
      console.log(`Intervallo: ${w.start.toISOString()} / ${w.end.toISOString()}`);
      console.log(`Conflitti trovati: ${r.rowCount}`);
      console.table(r.rows);
      console.log('PASS: query SQL eseguita correttamente');
    }

    // Individua un'occupazione reale, se presente, e verifica la sovrapposizione
    // senza creare alcun dato artificiale nel DB.
    const sample = await client.query(`
      SELECT id::text, 'attivazione' AS origine,
        COALESCE((piano->>'busyStart')::timestamptz,partenza) AS inizio,
        COALESCE((piano->>'busyEnd')::timestamptz,arrivo) AS fine
      FROM public.popbus_attivazioni
      WHERE veicolo_id=$1 AND stato IN ('in_attesa_autista','confermata')
      ORDER BY partenza DESC LIMIT 1
    `, [id]);
    if (sample.rows.length && sample.rows[0].inizio && sample.rows[0].fine) {
      const s = sample.rows[0];
      const start = new Date(s.inizio);
      const end = new Date(s.fine);
      if (end > start) {
        const overlap = await client.query(conflictsSQL, [id, start, end]);
        const hasSample = overlap.rows.some(x => x.origine === 'attivazione' && x.id === s.id);
        if (!hasSample) throw new Error(`Conflitto reale ${s.id} non rilevato`);
        console.log(`\nPASS: attivazione reale ${s.id} rilevata nella propria finestra`);
      } else {
        console.warn('AVVISO: attivazione campione con intervallo non valido');
      }
    } else {
      console.log('\nINFO: nessuna attivazione reale utilizzabile come campione; test sovrapposizione reale NON conclusivo.');
    }

    console.log('\nPASS: diagnostica SQL terminata senza scritture.');
    console.log('NON CERTIFICATI: concorrenza transazionale, completezza dei busy interval per corse legacy, corsa unica.');
  } catch (error) {
    console.error('\nFAIL:', error?.message || error);
    process.exitCode = 1;
  } finally {
    if (client) {
      if (began) {
        try { await client.query('ROLLBACK'); }
        catch (e) { console.error('ROLLBACK non riuscito:', e.message); process.exitCode = 1; }
      }
      client.release();
    }
    await pool.end();
  }
}
