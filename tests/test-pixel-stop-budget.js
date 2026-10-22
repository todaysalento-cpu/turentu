// tests/test-pixel-stop-budget.js
// Diagnostica di sola lettura: non inserisce fermate.
import { pool } from '../db/db.js';
import { getPixelStopBudget } from '../services/pixel/pixel-stop-budget.service.js';

try {
  const nodes = await pool.query(
    `SELECT id, nome, codice_istat_comune FROM public.nodi_territoriali ORDER BY id`
  );
  const rows = [];
  for (const node of nodes.rows) {
    try {
      const b = await getPixelStopBudget(node.id);
      rows.push({ nodo: node.id, nome: node.nome, comune: b.codice_istat_comune,
        limite: b.limite, censite: b.censite, residue: b.residue });
    } catch (error) {
      rows.push({ nodo: node.id, nome: node.nome, errore: error.message });
    }
  }
  console.log('PIXEL - BUDGET COMUNALE CONDIVISO (SOLA LETTURA)');
  console.table(rows);
  const tricase = rows.filter(r => r.comune === '075088');
  if (tricase.length === 2 && tricase[0].limite === tricase[1].limite &&
      tricase[0].residue === tricase[1].residue) {
    console.log('OK: Tricase e Lucugnano condividono lo stesso budget.');
  } else {
    console.error('ATTENZIONE: budget Tricase/Lucugnano da verificare.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
