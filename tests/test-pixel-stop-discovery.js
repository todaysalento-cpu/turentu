// tests/test-pixel-stop-discovery.js
// Default: diagnosi SOLO DB, zero chiamate Google, zero scritture.
// Con --live <id>: effettua chiamate Google Places e stampa solo un riepilogo,
// non persiste dettagli né li esporta su file.
import { pool } from '../db/db.js';
import { getPixelDiscoveryContext, discoverPixelStopCandidates } from '../services/pixel/pixel-stop-discovery.service.js';

try {
  const args = process.argv.slice(2);
  if (args[0] === '--live') {
    const id = Number(args[1]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Uso: --live <id_nodo>');
    const result = await discoverPixelStopCandidates(id);
    console.log('PIXEL - GOOGLE PLACES DIAGNOSTICA TRANSITORIA');
    console.log({ nodo: result.nodo.nome, comune: result.nodo.comune,
      limite: result.budget.limite, residue: result.budget.residue,
      candidati_trovati: result.candidati_totali ?? 0,
      candidati_selezionati: result.candidati.length, stato: result.stato,
      errori: result.errori });
    // I dettagli Google non vengono stampati per evitare che finiscano nei log persistenti.
  } else if (args.length === 0) {
    const { rows } = await pool.query('SELECT id FROM public.nodi_territoriali WHERE attivo = TRUE ORDER BY id');
    const out = [];
    for (const r of rows) {
      const { nodo, budget } = await getPixelDiscoveryContext(r.id);
      out.push({ nodo: nodo.id, nome: nodo.nome, comune: nodo.comune,
        limite: budget.limite, censite: budget.censite, residue: budget.residue });
    }
    console.log('PIXEL - SCOPERTA FERMATE: PRECHECK SOLA LETTURA');
    console.table(out);
  } else throw new Error('Uso: node tests/test-pixel-stop-discovery.js [--live <id_nodo>]');
} catch (e) {
  console.error('ERRORE:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
