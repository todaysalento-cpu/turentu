
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { databaseOptions } = await import('../config/database.js');
  const config = databaseOptions();
  const url = new URL(config.connectionString);

  const destination = 'D:\\TURENTU\\backup-procaccio';
  fs.mkdirSync(destination, { recursive: true });

  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, '-');

  const output = path.join(
    destination,
    `procaccio-render-${timestamp}.dump`
  );

  const executable =
    'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe';

  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
   PGSSLMODE: config.ssl ? 'require' : 'disable'
  };

  // Nessuna password viene stampata o passata come argomento.
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file', output,
    '--table=public.procaccio_*'
  ];

  console.log('Avvio backup Procaccio Render...');

  const result = spawnSync(executable, args, {
    env,
    stdio: ['ignore', 'inherit', 'inherit']
  });

  if (result.error || result.status !== 0) {
    console.error('Backup fallito:', result.error?.message || result.status);
    process.exitCode = 1;
    return;
  }

  const size = fs.statSync(output).size;

  if (size === 0) {
    console.error('ERRORE: file backup vuoto');
    process.exitCode = 1;
    return;
  }

  console.log('BACKUP CREATO:', output);
  console.log('DIMENSIONE:', size, 'byte');
})().catch(error => {
  console.error('ERRORE:', error.message);
  process.exitCode = 1;
});
