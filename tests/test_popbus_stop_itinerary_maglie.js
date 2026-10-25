
import assert from 'node:assert/strict';
import { costruisciSequenzaFermate }
  from '../services/popbus/v2/popbus-stop-itinerary.service.js';

const fermata14 = {
  fermata_id: 14,
  lat: 40.121583,
  lon: 18.305914
};

const fermata15 = {
  fermata_id: 15,
  lat: 40.1258486502909,
  lon: 18.299920672780097
};

const assegnazioni = [
  {
    richiesta_id: 900001,
    start_territoriale: 0,
    end_territoriale: 1,
    posti_richiesti: 2,
    salita: fermata14,
    discesa: fermata15
  }
];

console.log('=== POPBUS V2 - TEST ITINERARIO MAGLIE ===');

const risultato = costruisciSequenzaFermate({
  assegnazioni,
  postiTotali: 4
});

assert.equal(risultato.ok, true);
assert.equal(risultato.visite.length, 2);
assert.equal(risultato.visite[0].fermata_id, 14);
assert.equal(risultato.visite[1].fermata_id, 15);
assert.equal(risultato.peak, 2);
assert.equal(risultato.visite[0].occupatiDopoVisita, 2);
assert.equal(risultato.visite[1].occupatiDopoVisita, 0);
assert.equal(risultato.attivabile, false);

console.table(
  risultato.visite.map(v => ({
    visita: v.visita_id,
    fermata: v.fermata_id,
    operazioni: v.eventi.map(e => e.tipo).join(', '),
    occupatiDopoVisita: v.occupatiDopoVisita
  }))
);

console.log({
  stato: risultato.stato,
  peak: risultato.peak,
  postiTotali: risultato.postiTotali,
  routingVerificato: risultato.routingVerificato,
  qualitaVerificata: risultato.qualitaVerificata,
  attivabile: risultato.attivabile
});

console.log('\nPASS: sequenza preliminare verificata.');
