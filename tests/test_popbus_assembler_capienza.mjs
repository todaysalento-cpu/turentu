// TURENTU POPBUS - TEST 7: CAPIENZA GLOBALE CICLO (SOLA LETTURA)
// Salvare come tests/test_popbus_assembler_capienza.mjs
// Eseguire: node tests/test_popbus_assembler_capienza.mjs
// Non usa DB, Stripe, socket, API esterne. Non modifica file.
import assert from 'node:assert/strict';
import { componiCicloInCorsa, calcolaOccupazioneCiclo } from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const BASE = Date.parse('2026-10-19T08:00:00.000Z');
const MIN = 60_000;
const nodi = [
  { id: 7, lat: 40.3515, lon: 18.1750, nome_nodo: 'Lecce' },
  { id: 5, lat: 40.1200, lon: 18.3000, nome_nodo: 'Maglie' },
  { id: 8, lat: 39.9300, lon: 18.3600, nome_nodo: 'Tricase' },
  { id: 9, lat: 40.0000, lon: 18.3400, nome_nodo: 'Intermedio' }
];
// Polilinee di test non utilizzabili per validazione geografica: qui si verifica
// solo la composizione temporale e la capienza. Non simulano Google routing.
const leg = (minutes = 30) => ({ metres: 20_000, seconds: minutes * 60, polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' });
const req = (id, start, end, posti_richiesti) => ({ id, start, end, posti_richiesti });
const missione = (corridorId, nodes, startMin, durataMin, requests) => ({
  corridorId, nodes, legs: Array.from({ length: nodes.length - 1 }, () => leg(durataMin / (nodes.length - 1))),
  departure: BASE + startMin * MIN, arrival: BASE + (startMin + durataMin) * MIN,
  requests
});
function ciclo(opts = {}) {
  const missioni = opts.missioni ?? [
    missione('m1', [7, 5], 0, 30, [req(101, 0, 1, 2)]),
    missione('m2', [5, 8], 50, 30, [req(102, 0, 1, 3)]),
    missione('m3', [8, 7], 100, 30, [req(103, 0, 1, 2)])
  ];
  return componiCicloInCorsa({
    missioni,
    trasferimenti: opts.trasferimenti ?? [
      { seconds: 0, attesaMinuti: 20 }, { seconds: 0, attesaMinuti: 20 }
    ],
    nodi, veicoloId: 353, postiTotali: opts.postiTotali === undefined ? 4 : opts.postiTotali,
    busyStart: BASE - 15 * MIN, busyEnd: BASE + 145 * MIN,
    approach: { metres: 5000, seconds: 900 }, returnTrip: { metres: 5000, seconds: 900 }
  });
}
let pass = 0, fail = 0;
function check(nome, fn) {
  try { fn(); pass++; console.log('PASS', nome); }
  catch (e) { fail++; console.error('FAIL', nome, '-', e.message); }
}
function rejects(nome, fn, regex) { check(nome, () => assert.throws(fn, regex)); }
console.log('=== TURENTU POPBUS / TEST 7 CAPIENZA GLOBALE ===');
const p = ciclo();
check('Tre missioni e una sola sequenza globale', () => {
  assert.equal(p.missioni.length, 3);
  assert.equal(p.nodes.length, p.legs.length + 1);
  assert.equal(p.evaluation.requests.length, 3);
});
check('Capienza validata con 4 posti', () => {
  assert.equal(p.validazioneCapienza.verificata, true);
  assert.equal(p.validazioneCapienza.postiTotali, 4);
});
check('Picco 3 e totale trasportati 7', () => {
  assert.equal(p.evaluation.peak, 3);
  assert.equal(p.validazioneCapienza.peak, 3);
  assert.equal(p.validazioneCapienza.totalePasseggeri, 7);
});
check('Occupazione corretta anche durante le attese', () => {
  assert.deepEqual(p.validazioneCapienza.occupazioneSegmenti, [2, 0, 0, 3, 0, 0, 2]);
});
check('Indici globali delle tre richieste', () => {
  assert.deepEqual(p.evaluation.requests.map(r => [r.id, r.start, r.end]),
    [[101, 0, 1], [102, 3, 4], [103, 6, 7]]);
});
check('Salite e discese coincidono con i nodi previsti', () => {
  assert.deepEqual(p.evaluation.requests.map(r => [p.nodes[r.start], p.nodes[r.end]]),
    [[7, 5], [5, 8], [8, 7]]);
});
check('Le attese sommano 40 minuti', () => {
  assert.equal(p.legs.filter(l => l.attesa).length, 2);
  assert.equal(p.legs.filter(l => l.attesa).reduce((s, l) => s + l.seconds, 0), 2400);
});
check('Orari globali coerenti con partenza e arrivo', () => {
  assert.equal(p.evaluation.departure + p.evaluation.times.at(-1), p.evaluation.arrival);
});
check('Ritorno a Lecce consentito con indici distinti', () => {
  assert.equal(p.nodes[0], 7); assert.equal(p.nodes.at(-1), 7);
  assert.notEqual(p.evaluation.requests[0].start, p.evaluation.requests[2].end);
});
check('Rimane non attivabile anche con capienza valida', () => assert.equal(p.attivabile, false));
check('Occupazione sovrapposta entro capienza', () => {
  const o = calcolaOccupazioneCiclo([req(1, 0, 2, 2), req(2, 1, 3, 2)], 3, 4);
  assert.deepEqual(o.occupazioneSegmenti, [2, 4, 2]); assert.equal(o.peak, 4);
});
rejects('Sovrapposizione 2+3 supera 4 posti', () =>
  calcolaOccupazioneCiclo([req(1, 0, 2, 2), req(2, 1, 3, 3)], 3, 4), /Capienza superata/);
check('Discesa e salita sullo stesso indice non si sommano', () => {
  const o = calcolaOccupazioneCiclo([req(1, 0, 1, 4), req(2, 1, 2, 4)], 2, 4);
  assert.deepEqual(o.occupazioneSegmenti, [4, 4]); assert.equal(o.peak, 4);
});
rejects('Una richiesta da 5 posti supera capienza 4', () =>
  calcolaOccupazioneCiclo([req(1, 0, 1, 5)], 1, 4), /Capienza superata/);
rejects('Richiesta duplicata rifiutata', () =>
  calcolaOccupazioneCiclo([req(1, 0, 1, 1), req(1, 1, 2, 1)], 2, 4), /duplicata/);
rejects('Posti negativi rifiutati', () =>
  calcolaOccupazioneCiclo([req(1, 0, 1, -1)], 1, 4), /posti non validi/);
rejects('Indici fuori dal ciclo rifiutati', () =>
  calcolaOccupazioneCiclo([req(1, 0, 3, 1)], 2, 4), /Occorrenza/);
check('Capienza sconosciuta: occupazione calcolata ma non validata', () => {
  const x = ciclo({ postiTotali: null });
  assert.equal(x.evaluation.peak, 3);
  assert.equal(x.validazioneCapienza.verificata, false);
  assert.equal(x.validazioneCapienza.postiTotali, null);
  assert.equal(x.attivabile, false);
});
check('Posti richiesti assenti: peak non assegnato e validazione incompleta', () => {
  const ms = [
    missione('m1', [7, 5], 0, 30, [{ id: 101, start: 0, end: 1 }]),
    missione('m2', [5, 8], 50, 30, [req(102, 0, 1, 3)]),
    missione('m3', [8, 7], 100, 30, [req(103, 0, 1, 2)])
  ];
  const x = ciclo({ missioni: ms });
  assert.equal(Object.hasOwn(x.evaluation, 'peak'), false);
  assert.equal(x.validazioneCapienza.verificata, false);
  assert.equal(x.validazioneCapienza.occupazioneSegmenti, null);
});
rejects('Capienza del veicolo invalida rifiutata', () => ciclo({ postiTotali: 0 }), /Capienza veicolo non valida/);
rejects('Orari incompatibili tra missioni rifiutati', () =>
  ciclo({ trasferimenti: [{ seconds: 0, attesaMinuti: 19 }, { seconds: 0, attesaMinuti: 20 }] }), /Trasferimento\/attesa/);
rejects('Richiesta duplicata tra missioni rifiutata', () => {
  const ms = [
    missione('m1', [7, 5], 0, 30, [req(101, 0, 1, 2)]),
    missione('m2', [5, 8], 50, 30, [req(101, 0, 1, 3)]),
    missione('m3', [8, 7], 100, 30, [req(103, 0, 1, 2)])
  ];
  ciclo({ missioni: ms });
}, /Richiesta o indici non validi/);
console.log('\nRIEPILOGO', JSON.stringify({
  missioni: p.missioni.length, veicoloId: p.veicoloId,
  peak: p.evaluation.peak, totalePasseggeri: p.validazioneCapienza.totalePasseggeri,
  occupazioneSegmenti: p.validazioneCapienza.occupazioneSegmenti,
  validazioneCapienza: p.validazioneCapienza.verificata,
  attivabile: p.attivabile
}, null, 2));
console.log(`\nESITO: ${pass} PASS, ${fail} FAIL. Nessuna scrittura.`);
if (fail) process.exitCode = 1;
