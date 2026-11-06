import 'dotenv/config';

export function databaseOptions(env = process.env) {
  if (!env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL obbligatorio');
  let url;
  try { url = new URL(env.DATABASE_URL); }
  catch { throw new Error('DATABASE_URL non valido'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL deve usare PostgreSQL');
  }
  const mode = env.DATABASE_SSL_MODE || 'verify-full';
  if (!['verify-full', 'disable'].includes(mode)) {
    throw new Error('DATABASE_SSL_MODE deve essere verify-full o disable');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (mode === 'disable' && (!local || env.NODE_ENV === 'production')) {
    throw new Error('TLS disabilitabile soltanto per PostgreSQL locale non in produzione');
  }
  // pg legge questi parametri dopo le opzioni del Pool: non devono aggirare TLS.
  for (const name of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    url.searchParams.delete(name);
  }
  return {
    connectionString: url.toString(),
    ssl: mode === 'disable' ? false : {
      rejectUnauthorized: true,
      ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA.replace(/\\n/g, '\n') } : {}),
    },
    max: 75,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
  };
}
