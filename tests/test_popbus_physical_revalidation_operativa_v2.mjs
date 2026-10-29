import assert from 'node:assert/strict';
import { adattaMissioneFermate } from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';
import { rivalidaMissioniFisicheV2 } from '../services/popbus/v2/popbus-physical-writer-v2.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');
const id = 900001;
const richiesta = { id, posti_richiesti: 2, start_datetime: new Date(BASE).toISOString() };
const f14 = { fermata_id: 14, lat: 40.121583, lon: 18.305914 };
const f15 = { fermata_id: 15, lat: 40.12584865, lon: 18.29992067 };
const arrivo = BASE + 188000;
const itinerario = {
  ok: true, routingVerificato: true, departure: BASE,
  fineOperazioni: arrivo + 50000,
  visite: [
    { ...f14, arrivo: BASE, partenza: BASE + 50000, sostaSecondi: 50,
      eventi: [{ richiesta_id: id, tipo: 'salita', posti: 2, timestampOperazione: BASE }] },
    { ...f15, arrivo, partenza: arrivo + 50000, sostaSecondi: 50,
      eventi: [{ richiesta_id: id, tipo: 'discesa', posti: 2, timestampOperazione: arrivo }] }
  ],
  legs: [{ metres: 869, seconds: 138, polyline: 'fixture-non-certificata' }]
};
const alternativa = { sequenza: { ok: true }, temporale: { ok: true },
  qualita: { ok: true }, itinerario };
const adattata = adattaMissioneFermate({ alternativa, richieste: [richiesta], corridorId: 'TEST' });
assert.equal(adattata.ok, true);
assert.equal(adattata.missione.nodes.length, 4);
const missione = {
  schemaVersion: 2, tipoItinerario: 'FERMATE_FISICHE', pixelOpportunitaId: 500001,
  corridoioPixelId: 'TEST', departure: adattata.missione.departure,
  arrival: adattata.missione.arrival,
  plan: { nodes: adattata.missione.nodes, legs: adattata.missione.legs },
  evaluation: { requests: adattata.missione.requests },
  validazioneFisica: alternativa,
  nodiFisici: adattata.nodi
};
const verifica = (m = missione, r = richiesta) =>
  rivalidaMissioniFisicheV2({ ciclo: { missioni: [m] }, richiesteBloccate: [r] });

assert.equal(verifica().ok, true);
console.log('PASS 1 - missione reale adapter con soste');
assert.throws(() => verifica(missione, { ...richiesta, start_datetime: new Date(BASE + 90 * 60000).toISOString() }), /compatibilita temporale fallita/);
console.log('PASS 2 - orario fuori tolleranza');
assert.throws(() => verifica(missione, { ...richiesta, posti_richiesti: 3 }), /posti evento discordanti/);
console.log('PASS 3 - posti modificati');
assert.throws(() => verifica({ ...missione, plan: { ...missione.plan, nodes: [14, 14, 16, 15] } }), /fermata operativa discordante/);
console.log('PASS 4 - fermata alterata');
assert.throws(() => verifica({ ...missione, plan: { ...missione.plan, legs: missione.plan.legs.map((l, i) => i === 0 ? { ...l, seconds: l.seconds + 1 } : l) } }), /segmento operativo discordante/);
console.log('PASS 5 - sosta alterata');
assert.throws(() => verifica({ ...missione, evaluation: { requests: [{ ...missione.evaluation.requests[0], end: 1 }] } }), /mapping operativo richiesta discordante/);
console.log('PASS 6 - indice discesa alterato');
assert.throws(() => verifica({ ...missione, evaluation: { requests: [{ ...missione.evaluation.requests[0], id: 900002 }] } }), /richiesta non bloccata/);
console.log('PASS 7 - richiesta non bloccata');
console.log('RISULTATO: 7/7 test piano operativo V2 (fixture, non routing LIVE)');
