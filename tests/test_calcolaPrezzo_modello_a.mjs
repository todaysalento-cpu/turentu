// TURENTU - Test reale calcolaPrezzo Modello A, senza DB o Stripe
// Salvare come tests/test_calcolaPrezzo_modello_a.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'utils', 'pricing.util.js');
console.log('=== TURENTU | CALCOLAPREZZO MODELLO A | TEST REALE ===');
console.log('File:', file);
if (!fs.existsSync(file)) {
  console.error('ERRORE: file mancante:', file);
  process.exit(1);
}
let source = fs.readFileSync(file, 'utf8');
const importDb = /^\s*import\s*\{\s*pool\s*\}\s*from\s*['"]\.\.\/db\/db\.js['"];?\s*$/m;
if (!importDb.test(source)) {
  console.error('ERRORE: import DB non riconosciuto. Test interrotto senza eseguire codice del backend.');
  process.exit(1);
}
// Sostituiamo SOLO l'import DB, in memoria. Non tocchiamo il file sorgente.
source = source.replace(importDb, "const pool = { query: async () => { throw new Error('DB VIETATO NEL TEST'); } };");
let mod;
try {
  mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
} catch (e) {
  console.error('ERRORE caricamento modulo:', e.message);
  process.exit(1);
}
assert.equal(typeof mod.calcolaPrezzo, 'function', 'calcolaPrezzo deve essere esportata');
assert.equal(typeof mod.ripartisciCondivisaModelloA, 'function', 'Ripartizione Modello A deve essere esportata');

const snapshot = {
  costoCommercialeMissione: 123.53,
  kmPrimaPrenotazione: 100,
  prenotazioni: [
    { id: 'A', km: 100, posti: 1 },
    { id: 'B', km: 50, posti: 1 },
    { id: 'C', km: 80, posti: 2 },
  ],
};
const attesi = { A: 39.85, B: 19.92, C: 63.76 };
let totale = 0;
const righe = [];
for (const [id, prezzoAtteso] of Object.entries(attesi)) {
  const r = await mod.calcolaPrezzo(
    { modelloA: { ...snapshot, prenotazioneCorrenteId: id } },
    id === 'C' ? 2 : 1, 'condivisa', id === 'A' ? 100 : id === 'B' ? 50 : 80,
    100, 0, 'STANDARD', 10, 100, true
  );
  assert.ok(r, `Risultato nullo per ${id}`);
  assert.equal(r.prezzo, prezzoAtteso, `Prezzo ${id}`);
  assert.equal(r.prezzoCommerciale, prezzoAtteso, `Prezzo commerciale ${id}`);
  assert.equal(r.commissionePercentuale, 15, `Commissione ${id}`);
  assert.equal(r.costoCommercialeMissione, 123.53, `Costo fisso ${id}`);
  assert.ok(r.ripartizioneModelloA, `Ripartizione assente per ${id}`);
  totale += Math.round(r.prezzo * 100);
  righe.push({ prenotazione: id, prezzo: r.prezzo, commissione: r.commissioneImporto });
}
console.table(righe);
assert.equal(totale, 12353, 'La somma deve essere 123,53 euro');

// Verifica primo ingresso: paga il costo totale.
const primo = await mod.calcolaPrezzo({ modelloA: {
  costoCommercialeMissione: 123.53,
  kmPrimaPrenotazione: 100,
  prenotazioni: [{ id: 'A', km: 100, posti: 1 }],
  prenotazioneCorrenteId: 'A',
}}, 1, 'condivisa', 100, 100);
assert.equal(primo?.prezzo, 123.53);

// Uno snapshot incompleto deve essere rifiutato, non convertito in tariffa legacy.
const previousError = console.error;
console.error = () => {}; // Errore atteso: evita stack lunghissimo del modulo caricato in memoria
let invalido;
try {
  invalido = await mod.calcolaPrezzo({ modelloA: {
  costoCommercialeMissione: 123.53,
  kmPrimaPrenotazione: 100,
  prenotazioni: [{ id: 'A', km: 100, posti: 1 }],
  prenotazioneCorrenteId: 'inesistente',
}}, 1, 'condivisa', 100, 100);
} finally { console.error = previousError; }
assert.equal(invalido, null, 'Snapshot con ID inesistente deve fallire');

// Controllo di non regressione: privata senza veicolo_id, nessun accesso al DB.
const privata = await mod.calcolaPrezzo({}, 1, 'privata', 100, 100, 0, 'STANDARD', 10, 100);
assert.equal(privata?.prezzo, 123.53, 'Pricing privato di riferimento');
console.log('ESITO: TEST SUPERATO - calcolaPrezzo() reale, Modello A, commissione e regressione privata.');
console.log('DB e Stripe non utilizzati. Nessun file del backend modificato.');
