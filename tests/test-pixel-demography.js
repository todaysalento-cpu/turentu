// tests/test-pixel-demography.js
// Diagnostica in sola lettura: NON aggiorna PostgreSQL.
import { diagnosticaDemografiaPixel, calcolaMaxFermate } from '../services/pixel/pixel-demography.service.js';

console.log('PIXEL DEMOGRAFIA - TEST SOLA LETTURA');
console.log('Soglie di esempio:');
for (const p of [3000, 12000, 35000, 100000, 300000, 1000000]) {
  console.log(`${p} abitanti -> ${calcolaMaxFermate(p)} fermate`);
}
try {
  const rows = await diagnosticaDemografiaPixel();
  console.table(rows.map(r => ({
    id: r.id, localita: r.nome, popolazione: r.popolazione,
    stato: r.stato, calcolato: r.max_fermate_calcolato,
    override: r.max_fermate_override, effettivo: r.max_fermate_effettivo,
  })));
} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;
}
