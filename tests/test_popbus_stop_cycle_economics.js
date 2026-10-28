// TURENTU POPBUS V2 — test positivo economia cicli fisici.
// Fixture sintetici in memoria; nessuna scrittura DB, nessuna attivazione LIVE.
// Sostituire: tests/test_popbus_stop_cycle_economics.js
import assert from 'node:assert/strict';
import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const leg = (metres, seconds, polyline, extra = {}) => ({ metres, seconds, polyline, ...extra });
const clone = x => structuredClone(x);
const approx = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: atteso ${expected}, ricevuto ${actual}`);

function scenarioDueMissioni() {
  const departure = Date.parse('2027-04-01T08:00:00.000Z');
  const legs = [
    leg(0, 50, 'stop-101', { attesa: true }),
    leg(6000, 60, 'road-101-102'),
    leg(0, 60, 'stop-102', { attesa: true }),
    leg(6000, 60, 'road-102-103'),
    leg(0, 40, 'stop-103', { attesa: true }),
    leg(4000, 300, 'transfer-103-201'),
    leg(0, 180, 'wait-201', { attesa: true }),
    leg(0, 40, 'stop-201', { attesa: true }),
    leg(5000, 60, 'road-201-202'),
    leg(0, 50, 'stop-202', { attesa: true })
  ];
  const nodes = [101, 101, 102, 102, 103, 103, 201, 201, 201, 202, 202];
  const times = [0];
  for (const l of legs) times.push(times.at(-1) + l.seconds * 1000);
  const meta1 = { ordine: 1, startIndex: 0, endIndex: 5, richieste: [1, 2],
    partenza: departure + times[0], arrivo: departure + times[5] };
  const meta2 = { ordine: 2, startIndex: 7, endIndex: 10, richieste: [3],
    partenza: departure + times[7], arrivo: departure + times[10] };
  const req1 = { id: 1, start: 0, end: 2, posti_richiesti: 2 };
  const req2 = { id: 2, start: 2, end: 4, posti_richiesti: 2 };
  const req3 = { id: 3, start: 7, end: 9, posti_richiesti: 2 };
  return {
    ciclo: {
      tipoPiano: 'CICLO_PIXEL_CORSA_UNICA_V1', attivabile: false,
      validazioneCapienza: { verificata: true, peak: 2, postiTotali: 2 },
      legs, nodes, missioni: [meta1, meta2],
      evaluation: { departure, times, requests: [req1, req2, req3] }
    },
    missioniAdattate: [
      { nodes: nodes.slice(0, 6), legs: clone(legs.slice(0, 5)),
        requests: [clone(req1), clone(req2)], departure: meta1.partenza, arrival: meta1.arrivo },
      { nodes: nodes.slice(7, 11), legs: clone(legs.slice(7, 10)),
        requests: [{ id: 3, start: 0, end: 2, posti_richiesti: 2 }],
        departure: meta2.partenza, arrival: meta2.arrivo }
    ],
    missioni: [
      { sequenza: { ok: true }, temporale: { ok: true }, qualita: { ok: true },
        itinerario: { ok: true, routingVerificato: true,
          legs: [clone(legs[1]), clone(legs[3])] } },
      { sequenza: { ok: true }, temporale: { ok: true }, qualita: { ok: true },
        itinerario: { ok: true, routingVerificato: true, legs: [clone(legs[8])] } }
    ],
    trasferimenti: [{ metres: 4000, routingVerificato: true }],
    richieste: [{ id: 1, prezzo: 35 }, { id: 2, prezzo: 25 }, { id: 3, prezzo: 20 }],
    avvicinamento: { metres: 8000, routingVerificato: true },
    ritornoBase: { metres: 10000, routingVerificato: true },
    euroKm: 1.5
  };
}

function scenarioMissioneSingola(ricavoLordo) {
  const s = scenarioDueMissioni();
  const prima = s.ciclo.missioni[0];
  s.ciclo.nodes = s.ciclo.nodes.slice(0, prima.endIndex + 1);
  s.ciclo.legs = s.ciclo.legs.slice(0, prima.endIndex);
  s.ciclo.evaluation.times = s.ciclo.evaluation.times.slice(0, prima.endIndex + 1);
  s.ciclo.evaluation.requests = s.ciclo.evaluation.requests.slice(0, 2);
  s.ciclo.missioni = [prima];
  s.missioni = s.missioni.slice(0, 1);
  s.missioniAdattate = s.missioniAdattate.slice(0, 1);
  s.trasferimenti = [];
  // Due richieste sulla stessa missione, con ricavo totale configurabile.
  s.richieste = [{ id: 1, prezzo: ricavoLordo / 2 }, { id: 2, prezzo: ricavoLordo / 2 }];
  s.avvicinamento = { metres: 5000, routingVerificato: true };
  s.ritornoBase = { metres: 10000, routingVerificato: true };
  return s;
}

// 1) Due missioni: scenario di riferimento già validato dalla suite negativa.
{
  const r = valutaEconomiaCicloFermate(scenarioDueMissioni());
  assert.equal(r.ok, true);
  assert.equal(r.attivabile, false);
  assert.equal(r.economicamenteAttivabile, true);
  assert.deepEqual(r.richiesteValutate, [1, 2, 3]);
  approx(r.economia.km.totali, 39, 'km ciclo doppio');
  approx(r.economia.ricavoLordoEuro, 80, 'ricavo lordo doppio');
  approx(r.economia.commissioneTurentuEuro, 12, 'commissione doppio');
  approx(r.economia.margineEuro, 9.5, 'margine doppio');
  console.log('PASS due missioni: 39 km, 80 euro ricavi, 9.50 euro margine');
}

// 2) Una missione: 5 km approccio + 12 km missione + 10 km ritorno = 27 km.
// Ricavo 60 euro; commissione 9 euro; compenso NCC 40.50 euro; margine 10.50 euro.
{
  const r = valutaEconomiaCicloFermate(scenarioMissioneSingola(60));
  assert.equal(r.ok, true);
  assert.equal(r.attivabile, false);
  assert.equal(r.economicamenteAttivabile, true);
  assert.deepEqual(r.richiesteValutate, [1, 2]);
  approx(r.economia.km.totali, 27, 'km singola sostenibile');
  approx(r.economia.ricavoLordoEuro, 60, 'ricavo singola sostenibile');
  approx(r.economia.commissioneTurentuEuro, 9, 'commissione singola sostenibile');
  approx(r.economia.margineEuro, 10.5, 'margine singola sostenibile');
  console.log('PASS missione singola sostenibile: 27 km, margine 10.50 euro');
}

// 3) Stessa missione ma ricavi insufficienti: 35 * 0.85 - 27 * 1.5 = -10.75.
{
  const r = valutaEconomiaCicloFermate(scenarioMissioneSingola(35));
  assert.equal(r.ok, true);
  assert.equal(r.attivabile, false);
  assert.equal(r.economicamenteAttivabile, false);
  approx(r.economia.km.totali, 27, 'km singola non sostenibile');
  approx(r.economia.margineEuro, -10.75, 'margine singola non sostenibile');
  console.log('PASS missione singola non sostenibile: margine -10.75 euro, nessuna attivazione');
}

console.log('TEST STOP CYCLE ECONOMICS POSITIVO AGGIORNATO: 3 SCENARI SUPERATI');
