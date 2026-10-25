
import assert from 'node:assert/strict';

import { costruisciSequenzaFermate }
  from '../services/popbus/v2/popbus-stop-itinerary.service.js';

import { calcolaRoutingFermate }
  from '../services/popbus/v2/popbus-stop-routing.service.js';

import { verificaCompatibilitaTemporaleFermate }
  from '../services/popbus/v2/popbus-stop-temporal.service.js';

const departure = Date.parse('2026-11-01T10:00:00+01:00');

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

const richiesta = {
  id: 900001,
  start_datetime: new Date(departure).toISOString()
};

async function main() {
  console.log('=== POPBUS V2 - TEST INTEGRATO MAGLIE ===');

  // 1. Sequenza preliminare
  const sequenza = costruisciSequenzaFermate({
    assegnazioni: [{
      richiesta_id: richiesta.id,
      start_territoriale: 0,
      end_territoriale: 1,
      posti_richiesti: 2,
      salita: fermata14,
      discesa: fermata15
    }],
    postiTotali: 4
  });

  assert.equal(sequenza.ok, true);
  assert.equal(sequenza.peak, 2);

  // 2. Routing reale + soste
  const routing = await calcolaRoutingFermate({
    sequenza,
    departure,
    sostaBaseSecondi: 30,
    sostaPerPasseggeroSecondi: 10
  });

  assert.equal(routing.ok, true);
  assert.equal(routing.routingVerificato, true);
  assert.equal(routing.visite.length, 2);
  assert.equal(routing.legs.length, 1);
  assert.ok(routing.metriTotali > 0);
  assert.ok(routing.secondiViaggio > 0);
  assert.equal(routing.secondiSosta, 100);

  // Verifica della propagazione dei tempi
  assert.equal(routing.visite[0].arrivo, departure);
  assert.equal(routing.visite[0].sostaSecondi, 50);

  assert.equal(
    routing.visite[1].arrivo,
    departure +
      50 * 1000 +
      routing.secondiViaggio * 1000
  );

  // 3. Compatibilità temporale
  const temporale = verificaCompatibilitaTemporaleFermate({
    itinerario: routing,
    richieste: [richiesta],
    tolleranzaMs: 10 * 60 * 1000
  });

  assert.equal(temporale.ok, true);
  assert.equal(temporale.dettagli[0].fermataId, 14);
  assert.equal(temporale.dettagli[0].differenzaMinuti, 0);

  console.table(
    routing.visite.map(v => ({
      visita: v.visita_id,
      fermata: v.fermata_id,
      arrivo: new Date(v.arrivo).toISOString(),
      partenza: new Date(v.partenza).toISOString(),
      sosta_secondi: v.sostaSecondi,
      occupati: v.occupatiDopoVisita
    }))
  );

  console.log({
    metriTotali: routing.metriTotali,
    secondiViaggio: routing.secondiViaggio,
    secondiSosta: routing.secondiSosta,
    durataOperativaSecondi:
      (routing.fineOperazioni - departure) / 1000,
    compatibilitaTemporale: temporale.ok,
    attivabile: routing.attivabile
  });

  assert.equal(routing.attivabile, false);
  assert.equal(temporale.attivabile, false);

  console.log('\nPASS: sequenza, routing e tempi integrati.');
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
