// TURENTU — Test isolato generatore flotta, nessuna connessione DB.
// Copiare in tests/pixel_test-fleet-candidates-shadow.mjs
import assert from 'node:assert/strict';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';

const H = 3600_000;
const baseTime = Date.UTC(2027, 3, 1, 8, 0, 0);
const nodes = [
  {id: 6, lat: 39.905, lon: 18.364},
  {id: 5, lat: 40.118, lon: 18.299},
  {id: 7, lat: 40.352, lon: 18.176}
];
const [tiggiano, maglie, lecce] = nodes;
const vehicles = [
  {id: 101, driver_id: 88, posti_totali: 8, euro_km: 0.5, ...tiggiano, id: 101},
  {id: 102, driver_id: 88, posti_totali: 8, euro_km: 0.5, ...tiggiano, id: 102}
];
const req = (id, from, to, hours, prezzo = 100) => ({
  id, start_node_id: from, end_node_id: to,
  start_datetime: new Date(baseTime + hours * H).toISOString(),
  posti_richiesti: 2, prezzo, classe: 'STANDARD'
});
const requests = [req(900001, 6, 5, 0), req(900002, 5, 7, 1), req(900003, 7, 6, 2)];
let calls = 0;
const road = async (a,b) => {
  calls++;
  if (Math.abs(a.lat-b.lat) < 1e-7 && Math.abs(a.lon-b.lon) < 1e-7)
    return {metres: 0, seconds: 0, roadCoincident: true};
  return {metres: 20_000, seconds: 1800};
};
const options = {now: baseTime-2*H, strict: true, maxWaitMin: 90};
const run = (r=requests,v=vehicles,extra={}) => generaCandidatiFlotta(
  {requests:r,nodes,vehicles:v,road,...extra},options
);
const report = await run();
assert(report.candidati.length > 0);
console.log('OK 1: missioni preliminari generate');
assert(report.candidati.some(c=>c.missioni===3));
console.log('OK 2: catena di tre missioni compatibili');
assert(report.candidati.some(c=>c.veicolo===101) && report.candidati.some(c=>c.veicolo===102));
console.log('OK 3: veicoli distinti dello stesso titolare ammessi');
assert(report.candidati.every(c=>c.validazione_preliminare===false));
assert.equal(report.utilizzabiliPerAttivazione,false);
console.log('OK 4: nessuna attivazione senza validatori');
const cheap = await run(requests.map(r=>({...r,prezzo:0})),vehicles);
assert.equal(cheap.candidati.length,0);
console.log('OK 5: ricavi insufficienti non attivano candidati');
const validated = await run(requests,vehicles,{
  validateVehicle: async()=>true,
  validateCandidate: async()=>true
});
assert(validated.candidati.length>0);
assert(validated.candidati.every(c=>c.validazione_preliminare===true));
assert.equal(validated.utilizzabiliPerAttivazione,false);
console.log('OK 6: validazione preliminare non equivale ad attivazione');
assert(calls>0);
console.log('PIXEL / FLEET SHADOW: 6 verifiche superate; routing simulato; nessuna query DB');
