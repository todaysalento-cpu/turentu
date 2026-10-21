import 'dotenv/config';
import { pool } from '../db/db.js';

try {
  const { rows } = await pool.query(`
    SELECT
      r.stato,
      COUNT(*)::int AS totale
    FROM public.popbus_riserve r
    LEFT JOIN public.popbus_payment_reconciliation j
      ON j.riserva_id = r.id
    WHERE r.payment_intent_id IS NOT NULL
      AND r.prenotazione_id IS NULL
      AND (
        r.stato IN ('scaduta', 'annullata')
        OR (r.stato = 'riservata' AND r.expires_at <= NOW())
      )
      AND (j.id IS NULL OR j.stato IN ('pending', 'retry', 'processing'))
      AND (
        j.id IS NULL
        OR j.stato <> 'retry'
        OR j.prossimo_tentativo_at IS NULL
        OR j.prossimo_tentativo_at <= NOW()
      )
      AND (
        j.id IS NULL
        OR j.stato <> 'processing'
        OR j.claimed_at < NOW() - INTERVAL '5 minutes'
      )
    GROUP BY r.stato
    ORDER BY r.stato
  `);

  console.log('[POPBUS 5F] Riserve eleggibili:');
  console.table(rows);
  console.log('[POPBUS 5F] Totale:', rows.reduce((sum, r) => sum + r.totale, 0));
} catch (error) {
  console.error('[POPBUS 5F] ERRORE:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}