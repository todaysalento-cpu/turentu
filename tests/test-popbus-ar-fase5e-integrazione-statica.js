// TURENTU - FASE 5E - audit statico, nessun database e nessun import eseguito.
// node tests/test-popbus-ar-fase5e-integrazione-statica.js
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync('services/popbus/v2/acceptance.js', 'utf8');
const checks = [
 ['export ordinario conservato', /export async function accettaAttivazione\(/],
 ['motore interno privato', /async function convertiAttivazioneInterna\(/],
 ['simbolo interno non esportato', /const AR_INTERNAL = Symbol\(/],
 ['ordinario usa null', /return convertiAttivazioneInterna\(client, offertaId, autistaId, sceltaConducente, null\)/],
 ['guardia provvisoria', /coordinataAR \? arProvvisorie\.length !== 1 : arProvvisorie\.length > 0/],
 ['guardia richieste ordinarie', /!coordinataAR && requests\.some\(r => r\.ar_vincolata === true\)/],
 ['controllo PIXEL', /verificaAccettazionePixel\(client, a, plan\)/],
 ['controllo pagamento', /await verificaPagamento\(client, r\)/],
 ['controllo veicolo', /FROM veicolo/],
 ['preflight A/R', /await preflightTransazionaleAR\(client, root\)/],
 ['identita A/R', /await verificaIdentitaOfferteAR\(client, analisi\)/],
 ['transazione BEGIN', /await client\.query\('BEGIN'\)/],
 ['transazione COMMIT', /await client\.query\('COMMIT'\)/],
 ['transazione ROLLBACK', /await client\.query\('ROLLBACK'\)/],
 ['coppia A/R post conversione', /pairs\.some\(p => p\.totale !== 2 \|\| p\.andate !== 1 \|\| p\.ritorni !== 1\)/],
 ['aggiornamento gruppi', /UPDATE ar_gruppi SET stato = 'confermato'/],
 ['aggiornamento accettazioni', /UPDATE popbus_ar_accettazioni SET stato = 'confermata'/]
];
for (const [name, regex] of checks) {
  assert.match(src, regex, `Manca: ${name}`);
  console.log(`OK: ${name}`);
}
console.log(`FASE 5E: ${checks.length}/${checks.length} CONTROLLI STATICI SUPERATI. NESSUN DATABASE.`);
