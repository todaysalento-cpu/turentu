// TURENTU - Test integrato SHADOW PIXEL -> fermate POPBUS V2.
// Servizi reali: assignment, itinerary, routing, temporal, quality, evaluator, mission adapter.
// Simulati SOLO catalogo fermate e funzione routing. Nessuna query PostgreSQL.
import assert from 'node:assert/strict';
import { generaAlternativeFisichePixelShadow } from '../services/popbus/v2/popbus-pixel-stop-bridge.service.js';

const T = Date.parse('2026-11-01T10:00:00+01:00');
const formazione = {
  pixelOpportunitaId: 301, pixelDirettriceId: 202, pixelVersione: 3,
  nodiTerritoriali: [5, 6], corridoioPixelId: 'territorial:5>6',
  departure: T,
  evaluation: { requests: [{ id: 900001, start: 0, end: 1, posti_richiesti: 2 }] }
};
const richiesta = {
  id: 900001, posti_richiesti: 2, start_datetime: new Date(T).toISOString(),
  prezzo: 11
};
const fermata = (fermata_id, lat, lon, distanza_metri) => ({
  fermata_id, lat, lon, distanza_metri, nome: `Fermata ${fermata_id}`,
  nodo_territoriale_id: fermata_id === 14 ? 5 : 6,
  tipi_veicolo_ammessi: ['autobus'], verificata: false
});
const candidati = [{
  richiesta_id: 900001,
  salita: [fermata(14, 40.1200, 18.3000, 50)],
  discesa: [fermata(15, 40.1250, 18.3050, 80)]
}];
let queryCount = 0;
let routingCount = 0;
const client = { query: async () => { queryCount++; throw Error('QUERY_DB_VIETATA'); } };
const routing = async (from, to) => {
  routingCount++;
  assert.equal(from.fermata_id, 14);
  assert.equal(to.fermata_id, 15);
  return { metres: 869, seconds: 138, polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' };
};
const servizi = {
  cercaFermateCandidate: async ({ richiestaIds }) => {
    assert.deepEqual(richiestaIds, [900001]);
    return candidati;
  }
};
let passed = 0;
async function test(label, fn) {
  await fn();
  console.log('PASS - ' + label);
  passed++;
}
const run = (richieste = [richiesta], postiTotali = 4) =>
  generaAlternativeFisichePixelShadow({
    client, formazione, richieste, postiTotali, tipoVeicolo: 'ncc',
    routing, servizi, maxCombinazioni: 10, maxValutazioni: 10
  });

await test('pipeline reale: fermate e routing fisico', async () => {
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.alternativeFisiche.length, 1, JSON.stringify(r.diagnostica));
  const a = r.alternativeFisiche[0];
  assert.equal(a.alternativa.itinerario.routingVerificato, true);
  assert.equal(a.alternativa.kmMissione, 0.869);
  assert.equal(a.alternativa.itinerario.secondiViaggio, 138);
  assert.equal(a.alternativa.itinerario.secondiSosta, 100);
  assert.equal(a.missione.arrival, T + 238000);
  assert.equal(a.alternativa.sequenza.peak, 2);
  assert.equal(a.alternativa.temporale.ok, true);
  assert.equal(a.alternativa.qualita.ok, true);
});
await test('mapping PIXEL e occorrenze fisiche conservati', async () => {
  const r = await run();
  const a = r.alternativeFisiche[0];
  assert.equal(r.pixelOpportunitaId, 301);
  assert.equal(r.pixelDirettriceId, 202);
  assert.equal(r.pixelVersione, 3);
  assert.deepEqual(r.nodiTerritoriali, [5, 6]);
  assert.deepEqual(a.missione.nodes, [14, 14, 15, 15]);
  assert.deepEqual(a.missione.requests.map(x => ({id:x.id,start:x.start,end:x.end})),
    [{id:900001,start:0,end:2}]);
  assert.equal(a.missione.legs.filter(x => x.attesa).length, 2);
});
await test('salita valutata alla fermata effettiva', async () => {
  const r = await run();
  const salita = r.alternativeFisiche[0].alternativa.temporale.dettagli[0];
  assert.equal(salita.fermataId, 14);
  assert.equal(salita.effettivo, T);
  assert.equal(salita.compatibile, true);
});
await test('orario incompatibile: nessuna alternativa valida', async () => {
  const r = await run([{...richiesta, start_datetime: new Date(T + 3*3600000).toISOString()}]);
  assert.equal(r.ok, true);
  assert.equal(r.alternativeFisiche.length, 0);
  assert.ok(r.diagnostica.valutazione.scartate > 0);
});
await test('capienza insufficiente: nessuna alternativa valida', async () => {
  const r = await run([richiesta], 1);
  assert.equal(r.ok, true);
  assert.equal(r.alternativeFisiche.length, 0);
  assert.ok(r.diagnostica.valutazione.scartate > 0);
});
await test('nessun filtro per veicolo; nessuna query DB e nessuna attivazione', async () => {
  const r = await run();
  assert.equal(r.alternativeFisiche.length, 1);
  assert.equal(r.attivabile, false);
  assert.equal(r.alternativeFisiche[0].attivabile, false);
  assert.equal(queryCount, 0);
  assert.ok(routingCount > 0);
});
console.log(`RISULTATO: ${passed} PASS, 0 FAIL; routing deterministico; DB 0 query; LIVE NO.`);
