// TURENTU POPBUS V2 - Test isolato capienza (sola memoria, nessun DB).
// Copiare questo file come tests/test_popbus_v2_capacity_isolato.js
// Eseguire: node tests\test_popbus_v2_capacity_isolato.js
import assert from 'node:assert/strict';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';

const now = Date.now();
const departure = new Date(now + 7 * 86400000).toISOString();
const nodes = [
  { id: 1, lat: 40.0000, lon: 18.0000 },
  { id: 2, lat: 40.0500, lon: 18.0500 },
];
const vehicles = capacities => capacities.map((posti_totali, i) => ({
  id: i + 1, lat: 40.0000, lon: 18.0000, posti_totali, euro_km: 0.10,
}));
const request = (id, posti_richiesti) => ({
  id, start_node_id: 1, end_node_id: 2,
  start_datetime: departure, posti_richiesti, prezzo: 1000, classe: 'STANDARD',
});
const road = async (a, b) => {
  if (a.lat === b.lat && a.lon === b.lon) {
    return { metres: 0, seconds: 0, roadCoincident: true };
  }
  return { metres: 10000, seconds: 900, roadCoincident: false };
};

async function runScenario(name, requests, capacities, expectedByVehicle) {
  const result = await generaCandidatiFlotta({
    requests, nodes, vehicles: vehicles(capacities), road,
  }, { strict: false, now });
  assert.equal(result.utilizzabiliPerAttivazione, false,
    `${name}: il test non deve certificare attivazioni`);
  assert.equal(result.diagnostica.routingErrori.length, 0,
    `${name}: errori di routing ${JSON.stringify(result.diagnostica.routingErrori)}`);
  assert.equal(result.diagnostica.limiti.length, 0,
    `${name}: limiti di enumerazione ${JSON.stringify(result.diagnostica.limiti)}`);
  for (const [vehicleId, expectedSets] of Object.entries(expectedByVehicle)) {
    const actual = result.candidati
      .filter(c => c.veicolo === Number(vehicleId) && c.missioni === 1)
      .map(c => c.richieste[0].slice().sort((a, b) => a - b).join(','));
    for (const ids of expectedSets.present ?? []) {
      assert(actual.includes(ids), `${name}: veicolo ${vehicleId} manca aggregazione ${ids}; ottenute ${actual}`);
    }
    for (const ids of expectedSets.absent ?? []) {
      assert(!actual.includes(ids), `${name}: veicolo ${vehicleId} ammette aggregazione non consentita ${ids}`);
    }
    for (const c of result.candidati.filter(c => c.veicolo === Number(vehicleId))) {
      for (const m of c.dettaglio_missioni) {
        assert(m.posti <= capacities[Number(vehicleId) - 1],
          `${name}: veicolo ${vehicleId}, missione con ${m.posti} posti oltre capienza`);
      }
    }
  }
  console.log(`OK ${name}: ${result.candidati.length} candidati preliminari`);
}

await runScenario('1 posto / veicolo 2', [request(101, 1)], [2], {
  1: { present: ['101'] },
});
await runScenario('3 posti / veicolo 2', [request(101, 3)], [2], {
  1: { absent: ['101'] },
});
await runScenario('3 posti / veicolo 4', [request(101, 3)], [4], {
  1: { present: ['101'] },
});
await runScenario('2+3 posti / veicolo 4', [request(101, 2), request(102, 3)], [4], {
  1: { present: ['101', '102'], absent: ['101,102'] },
});
await runScenario('2+3 posti / veicolo 5', [request(101, 2), request(102, 3)], [5], {
  1: { present: ['101,102'] },
});
console.log('TEST CAPACITA POPBUS V2 SUPERATO (isolato, senza scritture).');
