import assert from 'node:assert/strict';
import { adattaMissioneFermate } from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';
import { rivalidaMissioniFisicheV2 } from '../services/popbus/v2/popbus-physical-writer-v2.js';

// Fixture locale: geometria di test, NON routing stradale certificato per LIVE.
const BASE = Date.parse('2026-11-01T10:00:00+01:00');
const ID = 900001;
const richiesta = {
  id: ID,
  posti_richiesti: 2,
  start_datetime: new Date(BASE).toISOString()
};

function creaMissione(id = ID) {
  const arrivo = BASE + 188000;
  const req = { ...richiesta, id };
  const itinerario = {
    ok: true,
    routingVerificato: true,
    departure: BASE,
    fineOperazioni: arrivo + 50000,
    visite: [
      {
        fermata_id: 14, lat: 40.121583, lon: 18.305914,
        arrivo: BASE, partenza: BASE + 50000, sostaSecondi: 50,
        eventi: [{ richiesta_id: id, tipo: 'salita', posti: 2, timestampOperazione: BASE }]
      },
      {
        fermata_id: 15, lat: 40.12584865, lon: 18.29992067,
        arrivo, partenza: arrivo + 50000, sostaSecondi: 50,
        eventi: [{ richiesta_id: id, tipo: 'discesa', posti: 2, timestampOperazione: arrivo }]
      }
    ],
    legs: [{ metres: 869, seconds: 138, polyline: 'fixture-non-certificata' }]
  };
  const alternativa = {
    sequenza: { ok: true },
    temporale: { ok: true },
    qualita: { ok: true },
    itinerario
  };
  const adattata = adattaMissioneFermate({
    alternativa, richieste: [req], corridorId: 'TEST'
  });
  assert.equal(adattata.ok, true);
  return {
    schemaVersion: 2,
    tipoItinerario: 'FERMATE_FISICHE',
    pixelOpportunitaId: 500001,
    corridoioPixelId: 'TEST',
    departure: adattata.missione.departure,
    arrival: adattata.missione.arrival,
    plan: {
      nodes: adattata.missione.nodes,
      legs: adattata.missione.legs
    },
    evaluation: { requests: adattata.missione.requests },
    validazioneFisica: alternativa,
    nodiFisici: adattata.nodi
  };
}

const missione = creaMissione();
const verifica = (missioni, richiesteBloccate = [richiesta]) =>
  rivalidaMissioniFisicheV2({ ciclo: { missioni }, richiesteBloccate });

// 1. Missione positiva costruita tramite adapter, comprese le soste.
const positivo = verifica([missione]);
assert.equal(positivo.ok, true);
assert.equal(positivo.numeroMissioni, 1);
assert.equal(positivo.numeroRichieste, 1);
assert.equal(positivo.attivabile, false);
console.log('PASS 1 - rivalidazione fisica positiva');

// 2. Orario fuori tolleranza.
assert.throws(
  () => verifica([missione], [{
    ...richiesta,
    start_datetime: new Date(BASE + 90 * 60000).toISOString()
  }]),
  /compatibilita temporale fallita/
);
console.log('PASS 2 - orario modificato rifiutato');

// 3. Richiesta non bloccata.
assert.throws(
  () => verifica([missione], [{ ...richiesta, id: 900002 }]),
  /richiesta non bloccata/
);
console.log('PASS 3 - richiesta non bloccata rifiutata');

// 4. Richiesta duplicata fra due missioni.
assert.throws(
  () => verifica([creaMissione(ID), creaMissione(ID)]),
  /richiesta duplicata nel ciclo/
);
console.log('PASS 4 - richiesta duplicata rifiutata');

// 5. Fermata alterata: preserviamo la lunghezza del piano operativo.
const nodesAlterati = [...missione.plan.nodes];
nodesAlterati[2] = 16;
assert.throws(
  () => verifica([{
    ...missione,
    plan: { ...missione.plan, nodes: nodesAlterati }
  }]),
  /fermata operativa discordante/
);
console.log('PASS 5 - fermata discordante rifiutata');

// 6. Distanza stradale alterata, senza modificare il numero dei segmenti.
const legsAlterati = missione.plan.legs.map((leg, i) =>
  i === 1 ? { ...leg, metres: 9999 } : leg
);
assert.throws(
  () => verifica([{
    ...missione,
    plan: { ...missione.plan, legs: legsAlterati }
  }]),
  /segmento operativo discordante/
);
console.log('PASS 6 - segmento discordante rifiutato');

console.log('RISULTATO: 6/6 test rivalidazione fisica V2 superati (fixture locale, NON certificazione LIVE)');
