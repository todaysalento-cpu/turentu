// Controllo isolato: non importa server, scheduler, cache o servizi di pagamento.
import 'dotenv/config';
import pg from 'pg';
import { createClient } from 'redis';
import { databaseOptions } from '../config/database.js';

const configOnly = process.argv.includes('--config-only');
const timeoutMs = 8000;

function safeError(error) {
  const code = error.code || error.cause?.code;
  const known = {
    ENOTFOUND: 'Host non risolvibile', ECONNREFUSED: 'Connessione rifiutata',
    ETIMEDOUT: 'Tempo di connessione esaurito',
    CERT_HAS_EXPIRED: 'Certificato TLS scaduto',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Certificato TLS non attendibile',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Catena del certificato TLS non verificabile',
    '28P01': 'Autenticazione PostgreSQL fallita', '42501': 'Permessi PostgreSQL insufficienti',
    '3D000': 'Database inesistente', '57014': 'Query oltre il tempo massimo',
  };
  // Non stampare oggetti di errore o messaggi del provider: possono contenere URL.
  return { code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'CONNECTION_FAILED',
    error: known[code] || 'Controllo non riuscito; verificare configurazione e accesso di rete' };
}

async function checkPostgres(options) {
  const pool = new pg.Pool({ ...options, max: 1,
    connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs,
    statement_timeout: 5000, options: '-c default_transaction_read_only=on' });
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    const { rows: tls } = await client.query(
      'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    if (options.ssl && (tls[0]?.ssl !== true || client.connection.stream.authorized !== true)) {
      throw Object.assign(new Error(), { code: 'TLS_NOT_VERIFIED' });
    }
    const required = {
      utente: ['id', 'nome', 'email', 'tipo'],
      disponibilita_veicolo: ['id', 'veicolo_id', 'start', 'fine', 'inattivita'],
      veicolo: ['id', 'driver_id', 'coord', 'servizi'],
      posizione_veicolo: ['veicolo_id', 'coord', 'timestamp'],
      corse: ['id', 'stato', 'tipo_corsa', 'origine', 'destinazione'],
      corse_tratte: ['id', 'corsa_id', 'direzione', 'percorso_polyline'],
      direttrici_virtuali: ['id', 'stato'], nodi_territoriali: ['id', 'nome', 'posizione', 'attivo'],
      pagamenti: ['id', 'prenotazione_id', 'corsa_id', 'stato', 'importo', 'currency', 'stripe_payment_intent', 'commissione', 'guadagno_autista', 'updated_at'],
      prenotazioni: ['id', 'corsa_id', 'prezzo_totale'],
    };
    const { rows } = await client.query(`SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [Object.keys(required)]);
    const existing = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
    const missing = Object.entries(required).flatMap(([table, columns]) =>
      columns.filter(column => !existing.has(`${table}.${column}`)).map(column => `${table}.${column}`));
    await client.query('ROLLBACK');
    return { ok: missing.length === 0, connected: true, readOnly: true,
      tls: tls[0]?.ssl === true, tlsVersion: tls[0]?.version ?? null,
      certificateVerified: client.connection.stream.authorized === true,
      schemaChecked: true, missingColumns: missing };
  } catch (error) {
    return { ok: false, ...safeError(error) };
  } finally {
    // Distrugge la sessione: anche una transazione fallita non torna nel pool.
    if (client) client.release(true);
    await pool.end();
  }
}

async function checkRedis(url) {
  const client = createClient({ url,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
    disableOfflineQueue: true });
  client.on('error', () => {});
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (client.isOpen) client.destroy();
        reject(Object.assign(new Error(), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
    });
    const ping = await Promise.race([(async () => {
      await client.connect();
      return client.ping();
    })(), timeout]);
    return { ok: ping === 'PONG', connected: client.isReady, ping,
      tls: new URL(url).protocol === 'rediss:', writes: 0 };
  } catch (error) {
    return { ok: false, ...safeError(error) };
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}

try {
  let jwtConfigured = false;
  try {
    const { readJwtSecret } = await import('../config/security.js');
    readJwtSecret();
    jwtConfigured = true;
  } catch {
    // La validazione JWT non impedisce i controlli di connessione indipendenti.
  }
  const options = databaseOptions();
  if (!process.env.REDIS_URL) throw Object.assign(new Error(), { code: 'REDIS_NOT_CONFIGURED' });
  const dbUrl = new URL(options.connectionString), redisUrl = new URL(process.env.REDIS_URL);
  if (!['redis:', 'rediss:'].includes(redisUrl.protocol)) {
    throw Object.assign(new Error(), { code: 'REDIS_URL_INVALID' });
  }
  console.log(JSON.stringify({ check: 'configuration', ok: jwtConfigured,
    postgresHost: dbUrl.hostname, redisHost: redisUrl.hostname,
    postgresTlsVerification: options.ssl?.rejectUnauthorized === true,
    redisTlsConfigured: redisUrl.protocol === 'rediss:',
    jwtConfigured, workersStarted: false, configOnly }, null, 2));
  if (!jwtConfigured) process.exitCode = 1;
  if (!configOnly) {
    const results = await Promise.allSettled([checkPostgres(options), checkRedis(process.env.REDIS_URL)]);
    const report = Object.fromEntries(results.map((result, index) => [index === 0 ? 'postgres' : 'redis',
      result.status === 'fulfilled' ? result.value : { ok: false, ...safeError(result.reason) }]));
    console.log(JSON.stringify(report, null, 2));
    if (!report.postgres.ok || !report.redis.ok) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, ...safeError(error) }, null, 2));
  process.exitCode = 1;
}
