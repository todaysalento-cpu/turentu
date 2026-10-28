// TURENTU POPBUS V2 - Test RED geometria routing fermate
// Solo mock: nessuna connessione DB, nessuna scrittura, LIVE disabilitato.
// Copiare in tests/test_popbus_stop_routing_geometry_red.js per eseguirlo.
import assert from 'node:assert/strict';
import polyline from 'polyline';
import { calcolaRoutingFermate } from '../services/popbus/v2/popbus-stop-routing.service.js';

const a = { visita_id: 14, lat: 40.1000, lon: 18.3000, eventi: [{ posti: 1 }] };
const b = { visita_id: 15, lat: 40.1050, lon: 18.3050, eventi: [{ posti: 1 }] };
const sequenza = {
  ok: true,
  visite: [a, b],
  peak: 1,
  postiTotali: 4,
  capienzaVerificata: true
};

async function run(geometry) {
  return calcolaRoutingFermate({
    sequenza,
    departure: Date.parse('2027-04-01T10:00:00Z'),
    routing: async () => ({ metres: 869, seconds: 138, polyline: geometry })
  });
}

let pass = 0;
let red = 0;

const valid = polyline.encode([[a.lat, a.lon], [b.lat, b.lon]]);
const good = await run(valid);
assert.equal(good.ok, true);
assert.equal(good.routingVerificato, true);
pass++;
console.log('PASS: geometria valida');

for (const [name, geometry] of [
  ['polilinea malformata', '!!!'],
  ['polilinea non ancorata alle fermate', polyline.encode([[41.0, 19.0], [41.1, 19.1]])]
]) {
  try {
    await run(geometry);
    red++;
    console.log('RED: ' + name + ' ACCETTATA');
  } catch (error) {
    pass++;
    console.log('PASS: ' + name + ' rifiutata: ' + error.message);
  }
}

console.log('RISULTATO: ' + pass + ' PASS, ' + red + ' RED');
console.log('DB: nessuna query; LIVE: NO');
if (red) process.exitCode = 1;
