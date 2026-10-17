// TURENTU - TEST DIAGNOSTICO PROGRESSIONE PRENOTAZIONI MODELLO A
// Salva come tests/test_prenotazioni_progressive_modello_a.mjs
// Esegui: node tests\test_prenotazioni_progressive_modello_a.mjs
// SOLO LETTURA: non usa PostgreSQL, Stripe o scritture su file.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(__dirname, '..', 'utils', 'pricing.util.js');
console.log('=== TURENTU | PRENOTAZIONI PROGRESSIVE MODELLO A ===');
console.log('File controllato:', file);
if (!fs.existsSync(file)) { console.error('ERRORE: pricing.util.js non trovato'); process.exit(1); }

// Carica l'intero modulo originale, disabilitando solo import/export per evitare DB.
// Qualunque tentativo di query fallisce, così il test non può accedere al DB.
const source = fs.readFileSync(file, 'utf8')
  .replace(/^\s*import\s+\{\s*pool\s*\}\s+from\s+['"][^'"]+['"];?\s*$/m, '')
  .replace(/\bexport\s+(?=(?:async\s+)?function\s+)/g, '');
const sandbox = {
  console: { ...console, log: () => {}, warn: () => {}, error: (...args) => console.error(...args) },
  pool: { query: async () => { throw new Error('QUERY DB NON CONSENTITA NEL TEST'); } },
};
vm.createContext(sandbox);
try {
  vm.runInContext(source + '\nthis.__api = { calcolaPrezzo, ripartisciCondivisaModelloA };', sandbox, { filename: file, timeout: 3000 });
} catch (err) {
  console.error('ERRORE nel caricamento del pricing:', err.message);
  process.exit(1);
}
const { calcolaPrezzo, ripartisciCondivisaModelloA } = sandbox.__api;
const costoCommercialeMissione = 123.53;
const kmPrimaPrenotazione = 100;
const scenari = [
  { fase: 'Solo A', prenotazioni: [{ id: 'A', km: 100, posti: 1 }], attesi: { A: 123.53 } },
  { fase: 'A + B', prenotazioni: [{ id: 'A', km: 100, posti: 1 }, { id: 'B', km: 50, posti: 1 }], attesi: { A: 82.35, B: 41.18 } },
  { fase: 'A + B + C', prenotazioni: [{ id: 'A', km: 100, posti: 1 }, { id: 'B', km: 50, posti: 1 }, { id: 'C', km: 80, posti: 2 }], attesi: { A: 39.85, B: 19.92, C: 63.76 } },
];
const cents = n => Math.round(n * 100);
const risultati = [];
let previous = null;
for (const s of scenari) {
  const quote = ripartisciCondivisaModelloA({ costoCommercialeMissione, kmPrimaPrenotazione, prenotazioni: s.prenotazioni });
  const sum = quote.prenotazioni.reduce((n, r) => n + cents(r.prezzoTotale), 0);
  assert.equal(sum, cents(costoCommercialeMissione), `Somma non conservata: ${s.fase}`);
  for (const p of s.prenotazioni) {
    const corsa = {
      modelloA: { costoCommercialeMissione, kmPrimaPrenotazione, prenotazioni: s.prenotazioni, prenotazioneCorrenteId: p.id }
    };
    const result = await calcolaPrezzo(corsa, p.posti, 'condivisa', p.km, p.km, 0, 'STANDARD', 10, 100);
    assert.ok(result, `Risultato nullo: ${s.fase}/${p.id}`);
    assert.equal(cents(result.prezzo), cents(s.attesi[p.id]), `Prezzo inatteso: ${s.fase}/${p.id}`);
    assert.equal(cents(result.costoCommercialeMissione), cents(costoCommercialeMissione));
    assert.equal(cents(result.prezzoCommerciale), cents(result.prezzo), 'Commissione applicata due volte');
    assert.equal(cents(result.compensoAutista) + cents(result.commissioneImporto), cents(result.prezzo));
    if (previous && p.id in previous) {
      assert.ok(result.prezzo <= previous[p.id], `Prezzo aumentato dopo nuovo ingresso: ${p.id}`);
    }
    risultati.push({ fase: s.fase, prenotazione: p.id, km: p.km, posti: p.posti, prezzo: result.prezzo, commissione: result.commissioneImporto });
  }
  previous = Object.fromEntries(quote.prenotazioni.map(p => [p.id, p.prezzoTotale]));
}
// Controlla che un ID inesistente sia rifiutato.
const invalida = await calcolaPrezzo({ modelloA: { costoCommercialeMissione, kmPrimaPrenotazione, prenotazioni: scenari[0].prenotazioni, prenotazioneCorrenteId: 'NON_ESISTE' } }, 1, 'condivisa', 100, 100);
assert.equal(invalida, null, 'ID prenotazione assente: doveva essere rifiutato');
console.table(risultati);
console.log('ESITO: TEST SUPERATO - progressione A -> A+B -> A+B+C, somma costante, quote e commissioni.');
console.log('LIMITI: snapshot simulati in memoria. NON verifica salvataggi DB, aggiornamenti reali, concorrenza o Stripe.');
