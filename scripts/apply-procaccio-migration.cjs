
const fs = require('node:fs');

(async () => {
  const { pool } = await import('../db/db.js');
  const client = await pool.connect();

  const file = 'migrations/006_procaccio_importazione_excel.sql';
  const sql = fs.readFileSync(file, 'utf8');

  const clean = sql.replace(/--[^\r\n]*/g, '').trim();

  if (
    (clean.match(/\bBEGIN\s*;/gi) || []).length !== 1 ||
    (clean.match(/\bCOMMIT\s*;/gi) || []).length !== 1 ||
    !/\bCOMMIT\s*;\s*$/i.test(clean)
  ) {
    throw new Error('Struttura transazionale non valida');
  }

  let committed = false;

  try {
    await client.query("SET lock_timeout = '3s'");
    await client.query("SET statement_timeout = '30s'");

    console.log('Applicazione migrazione 006...');

    await client.query(sql);
    committed = true;

    console.log('MIGRAZIONE 006 APPLICATA');

  } catch (error) {
    console.error('MIGRAZIONE FALLITA:', error.message);

    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }

    process.exitCode = 1;

  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error('ERRORE:', error.message);
  process.exitCode = 1;
});
