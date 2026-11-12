import { pool } from '../db/db.js';

export async function accountExists(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) return false;
  const { rowCount } = await pool.query('SELECT 1 FROM public.utente WHERE id = $1', [value]);
  return rowCount === 1;
}
