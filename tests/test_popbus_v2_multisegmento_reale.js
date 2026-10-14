// Salva questo file come tests/test_popbus_v2_multisegmento_reale.js
// Esegui dalla root: node --env-file=.env tests\test_popbus_v2_multisegmento_reale.js
// Test senza database: usa routing reale (puo' consumare richieste API).

import assert from 'node:assert/strict';
import {
  generaCandidate,
  valutaRichieste,
  generaFormazioniAlternative,
  scegliAttivazioni,
} from '../services/popbus/v2/model.js';
import { pianifica, leg } from '../services/popbus/v2/planner.js';

const nodes = [
  { id: 13, lat: 39.905177, lon: 18.364465 },
  { id: 11, lat: 40.352200, lon: 18.175500 },
  { id: 12, lat: 40.632773, lon: 17.941872 },
];
const nodeById = new Map(nodes.map(n => [n.id, n]));
const depart = Date.parse('2026-10-14T09:00:00.000Z'); // 11:00 ora italiana
const classe = 'EXPRESS';

function richiesta(id, start_node_id, end_node_id, posti_richiesti, prezzo, start_datetime) {
  return { id, classe, start_node_id, end_node_id, posti_richiesti, prezzo,
    start_datetime: new Date(start_datetime).toISOString() };
}

try {
  console.log('=== POPBUS V2 | TEST MULTI-SEGMENTO REALE (SOLA LETTURA) ===');
  const segmentA = await leg(nodeById.get(13), nodeById.get(11));
  const segmentB = await leg(nodeById.get(11), nodeById.get(12));
  const ritorno = await leg(nodeById.get(12), nodeById.get(13));
  const requests = [
    richiesta(900001, 13, 11, 4, 45, depart),
    richiesta(900002, 13, 12, 5, 65, depart),
    richiesta(900003, 11, 12, 3, 25, depart + segmentA.seconds * 1000),
  ];
  const candidates = generaCandidate(requests);
  const candidate = candidates.find(c => c.nodes.join(',') === '13,11,12');
  assert.ok(candidate, 'Candidata 13>11>12 assente');
  console.log('Candidate:', candidates.map(c => c.nodes.join('>')).join(' | '));

  const plan = await pianifica(candidate, nodes);
  assert.deepEqual(plan.nodes, [13, 11, 12], 'Il planner ha prodotto nodi inattesi');
  assert.equal(plan.legs.length, 2, 'Numero segmenti inatteso');
  const evaluation = valutaRichieste(plan, requests, candidate.seeds);
  assert.ok(evaluation, 'Valutazione incompatibile');
  assert.deepEqual(evaluation.occupancy, [9, 8], 'Occupazione inattesa');
  assert.equal(evaluation.peak, 9);
  assert.equal(evaluation.requests.length, 3);
  assert.equal(evaluation.revenue, 135);
  assert.ok(Math.abs(evaluation.departure - depart) <= 30 * 60 * 1000);
  const formations = generaFormazioniAlternative(plan, requests, candidate.seeds, { maxFormazioni: 80 });
  assert.ok(formations.some(f => f.requests.length === 3 && f.occupancy.join(',') === '9,8'),
    'Formazione completa non presente');

  const vehicle = { id: 353, driver_id: 2, posti_totali: 10, euro_km: 0.60, ...nodeById.get(13) };
  const approach = { metres: 0, seconds: 0 }; // base del mezzo coincide con nodo 13 nello scenario
  const metres = plan.legs.reduce((sum, l) => sum + l.metres, 0) + approach.metres + ritorno.metres;
  const cost = Math.ceil((metres / 1000) * vehicle.euro_km * 100) / 100;
  const busyStart = evaluation.departure - approach.seconds * 1000;
  const busyEnd = evaluation.arrival + ritorno.seconds * 1000;
  assert.ok(evaluation.revenue >= cost, `Ricavo ${evaluation.revenue} inferiore al costo ${cost}`);
  assert.ok(busyEnd > evaluation.arrival);
  const chosen = scegliAttivazioni([{ plan, evaluation, vehicle, cost, busyStart, busyEnd }]);
  assert.equal(chosen.length, 1, 'Veicolo 353 non selezionato');

  console.log('Percorso:', plan.nodes.join(' > '));
  console.log('Segmenti:', plan.legs.map(l => `${(l.metres / 1000).toFixed(2)} km / ${(l.seconds / 60).toFixed(1)} min`).join(' | '));
  console.log('Occupazione:', evaluation.occupancy, '| Picco:', evaluation.peak);
  console.log('Richieste:', evaluation.requests, '| Formazioni:', formations.length);
  console.log('Ritorno:', (ritorno.metres / 1000).toFixed(2), 'km');
  console.log('Totale operativo:', (metres / 1000).toFixed(2), 'km');
  console.log('Ricavo:', evaluation.revenue.toFixed(2), 'EUR | Costo:', cost.toFixed(2), 'EUR');
  console.log('Busy:', new Date(busyStart).toISOString(), '->', new Date(busyEnd).toISOString());
  console.log('PASS: candidata, routing reale, tempi, 2 segmenti, occupazione [9,8], alternative, costo con ritorno, selezione.');
  console.log('NOTA: non verifica disponibilita DB, conflitti DB, pagamenti, persistenza o emissione offerte.');
} catch (error) {
  console.error('FAIL:', error.stack || error.message);
  process.exitCode = 1;
}
