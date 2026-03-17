import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'corse_db',
  password: 'Malecos83',
  port: 5432,
  max: 75,                   // massimo connessioni simultanee
  idleTimeoutMillis: 5000,    // chiude connessioni inattive
  connectionTimeoutMillis: 5000, // evita blocchi lunghi
});
