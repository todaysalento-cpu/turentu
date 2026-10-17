// TURENTU | MODELLO A | TEST V3
// Legge utils/pricing.util.js senza DB e senza Stripe.
// Salva in tests/test_pricing_modello_a.mjs ed esegui: node tests\test_pricing_modello_a.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filePath = path.join(root, 'utils', 'pricing.util.js');
console.log('=== TURENTU | TEST PRICING MODELLO A V3 ===');
console.log('File controllato:', filePath);
if (!fs.existsSync(filePath)) {
  console.error('ERRORE: file non trovato:', filePath);
  process.exit(1);
}
const source = fs.readFileSync(filePath, 'utf8');
const declaration = /export\s+function\s+ripartisciCondivisaModelloA\s*\(/g;
const match = declaration.exec(source);
if (!match) {
  console.error('ERRORE: funzione ripartisciCondivisaModelloA assente nel pricing.util.js locale.');
  console.error('Il file potrebbe essere ancora la versione originale. Nessun file e stato modificato.');
  process.exit(1);
}
// Individua la graffa della funzione e la sua chiusura bilanciata.
// Gestisce stringhe, template literal e commenti senza dipendere dall'indentazione.
const opening = source.indexOf('{', match.index + match[0].length);
if (opening < 0) throw new Error('Apertura funzione non trovata');
let depth = 0, end = -1, mode = 'code';
for (let i = opening; i < source.length; i++) {
  const c = source[i], n = source[i + 1];
  if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
  if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i++; } continue; }
  if (mode === 'single' || mode === 'double' || mode === 'template') {
    if (c === '\\') { i++; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) mode = 'code';
    continue;
  }
  if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
  if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
  if (c === "'") { mode = 'single'; continue; }
  if (c === '"') { mode = 'double'; continue; }
  if (c === '`') { mode = 'template'; continue; }
  if (c === '{') depth++;
  if (c === '}' && --depth === 0) { end = i + 1; break; }
}
if (end < 0) {
  console.error('ERRORE: chiusura funzione non individuata; controllare sintassi del sorgente.');
  process.exit(1);
}
const extracted = source.slice(match.index, end).replace(/^export\s+/, '');
const context = vm.createContext({});
vm.runInContext(extracted + '\nthis.ripartisci = ripartisciCondivisaModelloA;', context, { filename: filePath });
const ripartisci = context.ripartisci;
const snapshot = {
  costoCommercialeMissione: 123.53,
  kmPrimaPrenotazione: 100,
  prenotazioni: [
    { id: 'A', km: 100, posti: 1 },
    { id: 'B', km: 50, posti: 1 },
    { id: 'C', km: 80, posti: 2 }
  ]
};
const r = ripartisci(snapshot);
console.table(r.prenotazioni);
assert.equal(r.prenotazioni.reduce((s, p) => s + Math.round(p.prezzoTotale * 100), 0), 12353);
assert.deepEqual(Array.from(r.prenotazioni, p => p.prezzoTotale), [39.85, 19.92, 63.76]);
assert.equal(r.prenotazioni[2].quotaPercentuale, 0.8);
assert.equal(r.prenotazioni[2].posti, 2);
assert.equal(r.prenotazioni[2].pesoRipartizione, 160);
console.log('ESITO: TEST SUPERATO (ripartizione matematica).');
console.log('Non verifica calcolaPrezzo(), PostgreSQL, prenotazioni reali o Stripe.');
