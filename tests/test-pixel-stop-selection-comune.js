// tests/test-pixel-stop-selection-comune.js
// Esegue chiamate Google Places, ma NON salva o stampa i dettagli dei luoghi.
import { pool } from '../db/db.js';
import { discoverPixelComuneCandidates } from '../services/pixel/pixel-stop-selection-comune.service.js';

try {
  const comune = process.argv[2] ?? '075088';
  const r = await discoverPixelComuneCandidates(comune);
  console.log('PIXEL - SELEZIONE COMUNALE COORDINATA (SOLA LETTURA)');
  console.log({ comune: r.comune, nodi: r.nodi, limite: r.limite,
    censite: r.censite, residue: r.residue,
    candidati_locali_sommati: r.candidati_locali_sommati,
    candidati_distinti: r.candidati_distinti,
    selezionati_comunali: r.selezionati.length,
    copertura_nodi: r.copertura_nodi, stato: r.stato, errori: r.errori });
  console.log('Nessuna persistenza e nessuna validazione operativa.');
} catch (e) {
  console.error('ERRORE:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
