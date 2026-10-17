/**
 * Turentu POPBUS — test formatter economico, PIXEL e date.
 * SOLO LETTURA: nessuna connessione DB/Redis/Stripe/HTTP, nessuna scrittura.
 * Esecuzione dalla root del progetto:
 *   node tests\test_popbus_formatter_readonly.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const formatterPath = resolve('services/search/formatter/search.formatter.js');
const pricingPath = resolve('services/popbus/v2/cycle-pricing.js');
let tests = 0;
const pass = (name) => { tests++; console.log(`PASS ${name}`); };
const cents = (x) => Math.round(x * 100);

const cycleSource = await readFile(pricingPath, 'utf8');
const cycle = await import('data:text/javascript;base64,' + Buffer.from(cycleSource).toString('base64'));
const economics = (gross, cost) => cycle.valutaEconomiaCiclo({
  ricaviRichiesteEuro: [gross], kmAvvicinamento: 10,
  kmMissioni: 20, kmTrasferimenti: 0, kmRitornoBase: 20,
  euroKm: cost / 50
});
const example = economics(110, 100);
assert.equal(example.costoCompletoEuro, 100);
assert.equal(example.sogliaAttivazioneLordaEuro, 117.65);
assert.equal(example.economicamenteAttivabile, false);
assert.equal(example.km.ritornoBase, 20);
pass('cycle-pricing: ritorno, commissione 15%, soglia 117,65 EUR');

// Il formatter viene caricato in isolamento: sostituiamo SOLO gli import
// con stub in memoria. Non si invocano dipendenze reali né API esterne.
let source = await readFile(formatterPath, 'utf8');
const importPricing = /^import\s*\{\s*calcolaPrezzo\s*\}\s*from\s*['"][^'"]+['"];?\s*/m;
const importMaps = /^import\s*\{\s*getLocalitaSafe\s*,\s*getDurataDistanza\s*\}\s*from\s*['"][^'"]+['"];?\s*/m;
assert.match(source, importPricing, 'Import calcolaPrezzo inatteso: aggiornare il test');
assert.match(source, importMaps, 'Import maps inatteso: aggiornare il test');
source = source.replace(importPricing, 'const calcolaPrezzo = globalThis.__turentuTest.calcolaPrezzo;\n')
  .replace(importMaps, 'const { getLocalitaSafe, getDurataDistanza } = globalThis.__turentuTest;\n');

globalThis.__turentuTest = {
  calcolaPrezzo: async (_slot, _posti, _tipo, _kmUtente, _kmTotali, _esistenti, classe) => ({
    prezzo: classe === 'SAVER' ? 9.1 : classe === 'STANDARD' ? 10 : 10.4,
    targetPasseggeri: 4
  }),
  getLocalitaSafe: async ({ lat }) => lat > 40 ? 'Origine' : 'Destinazione',
  getDurataDistanza: async () => ({ distanzaKm: 20, durataMs: 30 * 60000 })
};
const originalLog = console.log;
console.log = () => {};
let formatResults;
try {
  ({ formatResults } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
} finally { console.log = originalLog; }

const request = {
  coord: { lat: 40.1, lon: 18.1 }, coordDest: { lat: 39.9, lon: 18.2 },
  start_datetime: '2027-04-01T17:00:00.000Z', posti_richiesti: 1,
  localitaOrigine: 'Origine', localitaDestinazione: 'Destinazione'
};
function formation(overrides = {}) {
  return {
    stato: 'in_formazione', richieste_compatibili: 1,
    posti_in_formazione: 2, picco_occupazione: 2,
    ricavo_attuale: 100, ricavo_con_richiesta: 110.4,
    costo_attivazione: 100, soglia_attivazione_lorda: 117.65,
    soglia_raggiunta: false, veicolo_riferimento_id: 7,
    ...overrides
  };
}
function virtualSlot(form) {
  return {
    id: 'virtual_pop_pending', tipo: 'pop-bus', is_pool: true,
    origine_nodo_territoriale_id: 6,
    destinazione_nodo_territoriale_id: 4,
    pixel_fermate_disponibili: true, pixel_stato: 'disponibile',
    km_avvicinamento: 10, km_riposizionamento: 20,
    veicoli_pool_ids: [7], formazioni_popbus: {
      EXPRESS: form, STANDARD: form, SAVER: form
    }, anteprima_formazione: true
  };
}
async function run(form) {
  const oldLog = console.log;
  console.log = () => {};
  try { return await formatResults(request, [virtualSlot(form)]); }
  finally { console.log = oldLog; }
}
const rows = await run(formation());
assert.equal(rows.length, 3);
assert.deepEqual(rows.map(x => x.classe), ['SAVER', 'STANDARD', 'EXPRESS']);
pass('tre opzioni virtuali SAVER / STANDARD / EXPRESS');

const express = rows.find(x => x.classe === 'EXPRESS');
assert.equal(express.id, 'virtual_pop_pending_express');
assert.equal(express.prezzo, 11); // 10,4 arrotondato per eccesso
assert.equal(express.ricavo_con_richiesta, 111);
assert.equal(express.soglia_attivazione_lorda, 117.65);
assert.equal(express.soglia_raggiunta, false);
assert.equal(express.ricavo_mancante_dopo_richiesta, 6.65);
assert.equal(express.posti_mancanti_dopo_richiesta_stimati, 1);
pass('prezzo arrotondato, deficit sulla soglia LORDA e posti mancanti');

assert.equal(express.commissione_turentu, 16.65);
assert.equal(express.ricavo_netto_con_richiesta, 94.35);
assert.equal(express.margine_netto_con_richiesta, -5.65);
pass('commissione 15% e margine netto informativo');

assert.equal(express.origine_nodo_territoriale_id, 6);
assert.equal(express.destinazione_nodo_territoriale_id, 4);
assert.equal(express.pixel_fermate_disponibili, true);
assert.equal(express.pixel_stato, 'disponibile');
assert.equal(express.start_datetime, request.start_datetime);
assert.equal(express.oraPartenza, request.start_datetime);
pass('campi PIXEL e start_datetime conservati');

const enough = (await run(formation({ ricavo_attuale: 108, ricavo_con_richiesta: 118.4 })))
  .find(x => x.classe === 'EXPRESS');
assert.equal(enough.ricavo_con_richiesta, 119);
assert.equal(enough.soglia_raggiunta, true);
assert.equal(enough.ricavo_mancante_dopo_richiesta, 0);
assert.equal(enough.stato_formazione, 'soglia_economica_raggiunta');
pass('soglia raggiunta solo oltre il minimo lordo');

const noThreshold = (await run(formation({ soglia_attivazione_lorda: null })))
  .find(x => x.classe === 'EXPRESS');
assert.equal(noThreshold.soglia_raggiunta, false);
assert.equal(noThreshold.ricavo_mancante_dopo_richiesta, null);
pass('senza soglia lorda non si inventa attivabilità');

const noFormation = (await run({ stato: 'nessuna_formazione' }))
  .find(x => x.classe === 'EXPRESS');
assert.equal(noFormation.formazione_disponibile, false);
assert.equal(noFormation.soglia_raggiunta, false);
pass('nessuna formazione: nessuna falsa attivazione');

console.log(`\nRISULTATO: ${tests} test superati. Nessuna operazione DB, Redis, Stripe o HTTP.`);
