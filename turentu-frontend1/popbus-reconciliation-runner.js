// Runner manuale, nessuno scheduler. DRY_RUN per impostazione predefinita.
import { riconciliaBatchPopbus } from '../services/popbus/v2/reservation-reconciliation.service.js';
import { pool } from '../db/db.js';
const live = process.env.POPBUS_RECON_MODE === 'RUN';
if (live && (process.env.POPBUS_RECON_ENABLED !== 'YES' || process.env.POPBUS_RECON_APPROVED !== 'YES')) {
  console.error('[POPBUS RECON] RUN bloccato: POPBUS_RECON_ENABLED e POPBUS_RECON_APPROVED devono essere YES');
  process.exitCode = 1;
} else {
  try {
    const result = await riconciliaBatchPopbus({ limit: Number(process.env.POPBUS_RECON_LIMIT || 20), dryRun: !live });
    console.log('[POPBUS RECON]', JSON.stringify(result,null,2));
    if (result.results.some(r=>r.outcome==='error')) process.exitCode=1;
  } catch(e) { console.error('[POPBUS RECON] ERRORE',e); process.exitCode=1; }
}
await pool.end();
