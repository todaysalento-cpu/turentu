
const fs = require('node:fs');

(async () => {
  const { pool } = await import('../db/db.js');

  const file = 'migrations/006_procaccio_importazione_excel.sql';
  const sql = fs.readFileSync(file, 'utf8');

  const senzaCommenti = sql.replace(/--[^\r\n]*/g, '');

  if (
    (senzaCommenti.match(/\bBEGIN\s*;/gi) || []).length !== 1 ||
    (senzaCommenti.match(/\bCOMMIT\s*;/gi) || []).length !== 1 ||
    !/\bCOMMIT\s*;\s*$/.test(senzaCommenti)
  ) {
    throw new Error('Struttura transazionale inattesa');
  }

  const testSql = sql.replace(
    /\bCOMMIT\s*;\s*$/i,
    'ROLLBACK;'
  );

  const client = await pool.connect();

 try {
  console.log('Avvio test migrazione Procaccio...');

  await client.query("SET lock_timeout = '3s'");
  await client.query("SET statement_timeout = '30s'");

  await client.query(testSql);
    console.log('TEST SQL SUPERATO');
    console.log('ROLLBACK ESEGUITO');
    console.log('Nessuna modifica permanente prevista');
  } catch (error) {
    console.error('TEST FALLITO:', error.message);
    process.exitCode = 1;

    try {
      await client.query('ROLLBACK');
    } catch (_) {}
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error('ERRORE:', error.message);
  process.exitCode = 1;
});
