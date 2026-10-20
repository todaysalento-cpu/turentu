/**
 * TURENTU POPBUS V2 — TEST DEL SELETTORE REALE, ISOLATO E SENZA DB
 * Importa scegliAttivazioni/economiaCandidato dal modulo operativo model.js.
 * Non invoca il worker, non crea missioni, non apre connessioni, non scrive.
 * Verifica inoltre staticamente se il worker disponibile usa PIXEL come fonte
 * operativa oppure soltanto come diagnostica shadow.
 * Esecuzione: node tests/test_popbus_v2_selettore_reale_isolato.js
 */
import { readFile } from 'node:fs/promises';
import { scegliAttivazioni, economiaCandidato } from '../services/popbus/v2/model.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';

const errors = [];
const checks = [];
const assert = (condition, label, detail = {}) => {
  checks.push({ label, ok: Boolean(condition), ...detail });
  if (!condition) errors.push(label);
};
const T = Date.UTC(2027, 10, 1, 12, 0, 0);
const minute = 60000;
const toIds = selected => selected.map(x => x._testId);

// Ogni candidato contiene TUTTI i campi che il modello operativo richiede:
// legs, approach, returnTrip, prezzo per richiesta, revenue e costo riconciliati
// al centesimo con la funzione di pricing reale.
function candidate({ name, vehicle = 361, operator = 2, ids = [1001], prices,
                     start = T, end = T + 45 * minute, seats = 8,
                     peak = ids.length, approachM = 0, tripM = 10000,
                     returnM = 0, euroKm = 0.6 }) {
  const list = prices ?? ids.map(() => 20);
  if (list.length !== ids.length) throw new Error('Fixture incoerente: prices/ids');
  const economy = valutaEconomiaCiclo({
    ricaviRichiesteEuro: list,
    kmAvvicinamento: approachM / 1000,
    kmMissioni: tripM / 1000,
    kmTrasferimenti: 0,
    kmRitornoBase: returnM / 1000,
    euroKm
  });
  return {
    _testId: name,
    plan: { nodes: [8, 5, 7], legs: [{ metres: tripM }] },
    approach: { metres: approachM },
    returnTrip: { metres: returnM },
    vehicle: { id: vehicle, driver_id: operator, posti_totali: seats, euro_km: euroKm },
    evaluation: {
      requests: ids.map(id => ({ id })),
      revenue: economy.centesimi.ricavoLordo / 100,
      peak,
      departure: start,
      arrival: end
    },
    ricaviRichiesteEuro: list,
    cost: economy.centesimi.costoCompleto / 100,
    busyStart: start,
    busyEnd: end
  };
}
function run(label, candidates, expected) {
  const chosen = scegliAttivazioni(candidates);
  const got = toIds(chosen);
  const distinctRequests = chosen.flatMap(c => c.evaluation.requests.map(r => Number(r.id)));
  assert(new Set(distinctRequests).size === distinctRequests.length,
    `${label}: nessuna richiesta duplicata`, { selected: got });
  assert(JSON.stringify(got) === JSON.stringify(expected),
    `${label}: scelta attesa`, { selected: got, expected });
  return chosen;
}

try {
  // 1) Due missioni simultanee di due veicoli dello stesso operatore.
  const a = candidate({ name: 'A', vehicle: 361, ids: [1001, 1002] });
  const b = candidate({ name: 'B', vehicle: 363, ids: [1003, 1004] });
  assert(economiaCandidato(a)?.economicamenteAttivabile === true, 'fixture A economicamente attivabile');
  assert(economiaCandidato(b)?.economicamenteAttivabile === true, 'fixture B economicamente attivabile');
  run('veicoli distinti stesso operatore', [a, b], ['A', 'B']);

  // 2) Stesso veicolo, cicli che si sovrappongono: uno soltanto.
  const c = candidate({ name: 'C', vehicle: 361, ids: [1005, 1006] });
  run('conflitto stesso veicolo', [a, c], ['A']);

  // 3) Stesso veicolo, cicli esattamente contigui: entrambi consentiti.
  const d = candidate({ name: 'D', vehicle: 361, ids: [1007], start: T + 45 * minute, end: T + 90 * minute });
  run('cicli contigui', [a, d], ['A', 'D']);

  // 4) Due veicoli distinti ma stessa richiesta: un solo assegnatario.
  const e = candidate({ name: 'E', vehicle: 363, ids: [1001] });
  run('richiesta duplicata', [a, e], ['A']);

  // 5) Capienza insufficiente: rifiutata.
  const f = candidate({ name: 'F', vehicle: 365, ids: [1008, 1009], seats: 1, peak: 2 });
  run('capienza insufficiente', [f], []);

  // 6) Costo ciclo completo non coperto: rifiutata.
  const g = candidate({ name: 'G', vehicle: 365, ids: [1010], prices: [1], approachM: 50000, tripM: 55000, returnM: 50000 });
  assert(economiaCandidato(g)?.economicamenteAttivabile === false, 'fixture G sotto soglia');
  run('economia insufficiente', [g], []);

  // 7) Componenti di ritorno mancanti: fail-closed.
  const h = candidate({ name: 'H', vehicle: 365, ids: [1011] });
  delete h.returnTrip;
  assert(economiaCandidato(h) === null, 'ciclo senza ritorno non valutabile');
  run('ritorno mancante', [h], []);

  // 8) Alterazione dei ricavi legacy: fail-closed.
  const i = candidate({ name: 'I', vehicle: 365, ids: [1012] });
  i.evaluation.revenue += 0.01;
  assert(economiaCandidato(i) === null, 'ricavi legacy incoerenti respinti');
  run('ricavi incoerenti', [i], []);

  // 9) Test di non ottimalita: la scelta e greedy, NON certifica il massimo globale.
  const large = candidate({ name: 'LARGE', vehicle: 361, ids: [2001, 2002, 2003], prices: [20, 20, 20] });
  const left = candidate({ name: 'LEFT', vehicle: 361, ids: [2001, 2002], prices: [40, 40] });
  const right = candidate({ name: 'RIGHT', vehicle: 363, ids: [2003, 2004], prices: [40, 40] });
  const greedy = run('greedy controesempio', [large, left, right], ['LARGE']);
  assert(greedy.length === 1, 'greedy non copre necessariamente tutte le richieste fattibili');

  // Analisi STATICA: il worker non viene importato/eseguito, per evitare side effect.
  let architecture = { workerLetto: false, pixelOperativoCertificato: false };
  try {
    const src = await readFile(new URL('../services/popbus/v2/worker.js', import.meta.url), 'utf8');
    architecture = {
      workerLetto: true,
      selettoreLegacyInvocato: /const\s+chosen\s*=\s*scegliAttivazioni\s*\(\s*feasible\s*\)/.test(src),
      pixelShadowFlag: /POPBUS_PIXEL_DB_SHADOW/.test(src),
      pixelShadowSoloLettura: /Opportunita PIXEL persistenti: controllo in sola lettura/.test(src),
      sceltaBasataSuPixelDimostrata: false,
      nota: 'Ricognizione statica, non prova di esecuzione del worker. Se il worker e cambiato, leggere manualmente il flusso.'
    };
  } catch (err) {
    architecture = { workerLetto: false, motivo: err.message, nota: 'Test comportamentali eseguiti sul model.js importato.' };
  }
  console.log('SELETTORE_ARCHITETTURA_JSON:' + JSON.stringify(architecture));
} catch (err) {
  errors.push(`eccezione: ${err.stack || err.message}`);
}

const result = {
  tipo: 'selettore_reale_isolato_no_database',
  test: checks.length,
  passati: checks.filter(c => c.ok).length,
  falliti: errors.length,
  controlli: checks,
  limiti: [
    'NON invoca worker, pagamenti, PIXEL, persistenza o concorrenza DB',
    'NON dimostra che il worker consumi operativamente le opportunita PIXEL',
    'NON certifica ottimizzazione globale: selettore greedy',
    'Fixture sintetiche future, nessuna missione reale attivata'
  ]
};
console.log('SELETTORE_E2E_ISOLATO_JSON:' + JSON.stringify(result));
if (errors.length) {
  console.error('SELETTORE_TEST_FALLITO:', errors.join(' | '));
  process.exitCode = 1;
} else {
  console.log('SELETTORE_TEST_OK: invarianti isolati verificati; NON e un E2E di produzione.');
}
