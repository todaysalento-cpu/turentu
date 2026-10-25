// TURENTU POPBUS V2 - Test negativi Cycle Economics + integrita' Mission Adapter.
// Solo dati sintetici in memoria. Nessun database, nessuna attivazione LIVE.
// Salvare come: tests/test_popbus_stop_cycle_economics_negative.js
import assert from 'node:assert/strict';
import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const leg = (metres, seconds, polyline, extra = {}) => ({ metres, seconds, polyline, ...extra });
const clone = x => structuredClone(x);

function scenarioValido() {
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
  const nodes = [101,101,102,102,103,103,201,201,201,202,202];
  const times = [0];
  for (const l of legs) times.push(times.at(-1) + l.seconds * 1000);
  const meta1 = { ordine: 1, startIndex: 0, endIndex: 5, richieste: [1, 2],
    partenza: departure + times[0], arrivo: departure + times[5] };
  const meta2 = { ordine: 2, startIndex: 7, endIndex: 10, richieste: [3],
    partenza: departure + times[7], arrivo: departure + times[10] };
  const req1 = { id: 1, start: 0, end: 2, posti_richiesti: 2 };
  const req2 = { id: 2, start: 2, end: 4, posti_richiesti: 2 };
  const req3 = { id: 3, start: 7, end: 9, posti_richiesti: 2 };
  const ciclo = {
    tipoPiano: 'CICLO_PIXEL_CORSA_UNICA_V1', attivabile: false,
    validazioneCapienza: { verificata: true },
    legs, nodes, missioni: [meta1, meta2],
    evaluation: { departure, times, requests: [req1, req2, req3] }
  };
  const missioniAdattate = [
    { nodes: nodes.slice(0, 6), legs: clone(legs.slice(0, 5)),
      requests: [clone(req1), clone(req2)], departure: meta1.partenza, arrival: meta1.arrivo },
    { nodes: nodes.slice(7, 11), legs: clone(legs.slice(7, 10)),
      requests: [{ id: 3, start: 0, end: 2, posti_richiesti: 2 }],
      departure: meta2.partenza, arrival: meta2.arrivo }
  ];
  const missioni = [
    { sequenza: { ok: true }, temporale: { ok: true }, qualita: { ok: true },
      itinerario: { ok: true, routingVerificato: true,
        legs: [clone(legs[1]), clone(legs[3])] } },
    { sequenza: { ok: true }, temporale: { ok: true }, qualita: { ok: true },
      itinerario: { ok: true, routingVerificato: true, legs: [clone(legs[8])] } }
  ];
  return {
    ciclo, missioni, missioniAdattate,
    trasferimenti: [{ metres: 4000, routingVerificato: true }],
    richieste: [{ id: 1, prezzo: 35 }, { id: 2, prezzo: 25 }, { id: 3, prezzo: 20 }],
    avvicinamento: { metres: 8000, routingVerificato: true },
    ritornoBase: { metres: 10000, routingVerificato: true },
    euroKm: 1.5
  };
}

const base = valutaEconomiaCicloFermate(scenarioValido());
assert.equal(base.ok, true);
assert.equal(base.attivabile, false);
assert.equal(base.economia.km.totali, 39);
assert.equal(base.economia.margineEuro, 9.5);
console.log('SCENARIO BASE SUPERATO');

const casi = [
  ['Prezzo mancante', s => { s.richieste.pop(); }],
  ['Richiesta duplicata', s => { s.richieste[1].id = 1; }],
  ['Richiesta non appartenente al ciclo', s => { s.richieste[2].id = 999; }],
  ['Capienza non verificata', s => { s.ciclo.validazioneCapienza.verificata = false; }],
  ['Qualita missione non verificata', s => { s.missioni[0].qualita.ok = false; }],
  ['Routing missione non verificato', s => { s.missioni[1].itinerario.routingVerificato = false; }],
  ['Ritorno alla base non verificato', s => { s.ritornoBase.routingVerificato = false; }],
  ['Chilometri prima missione incoerenti', s => { s.missioni[0].itinerario.legs[0].metres += 100; }],
  ['Chilometri seconda missione incoerenti', s => { s.missioni[1].itinerario.legs[0].metres += 100; }],
  ['Chilometri trasferimento incoerenti', s => { s.trasferimenti[0].metres += 100; }],
  ['Intervallo missione non valido', s => { s.ciclo.missioni[0].endIndex = 4; }],
  ['Richiesta fuori dalla propria missione', s => { s.ciclo.evaluation.requests[0].end = 8; }],
  ['Missioni sovrapposte', s => { s.ciclo.missioni[1].startIndex = 4; }],
  ['Tariffa NCC negativa', s => { s.euroKm = -1; }],
  ['Missioni adattate mancanti', s => { delete s.missioniAdattate; }],
  ['Numero segmenti originali alterato', s => { s.missioniAdattate[0].legs.pop(); }],
  ['Metri segmento assemblato alterati', s => { s.ciclo.legs[1].metres += 10; }],
  ['Durata segmento originale alterata', s => { s.missioniAdattate[0].legs[1].seconds += 1; }],
  ['Geometria stradale alterata', s => { s.ciclo.legs[1].polyline = 'other-road'; }],
  ['Geometria sosta alterata', s => { s.ciclo.legs[0].polyline = 'other-stop'; }],
  ['Flag sosta alterato', s => { delete s.ciclo.legs[0].attesa; }],
  ['Flag fermata coincidente alterato', s => { s.ciclo.legs[1].roadCoincident = true; }],
  ['Ordine segmenti originali scambiato', s => {
    [s.missioniAdattate[0].legs[1], s.missioniAdattate[0].legs[3]] =
      [s.missioniAdattate[0].legs[3], s.missioniAdattate[0].legs[1]];
  }],
  ['Nodo originale alterato', s => { s.missioniAdattate[0].nodes[2] = 999; }],
  ['Orario originale alterato', s => { s.missioniAdattate[1].arrival += 60000; }],
  ['Indice richiesta originale alterato', s => { s.missioniAdattate[0].requests[0].end = 3; }],
  ['Posti richiesta originale alterati', s => { s.missioniAdattate[1].requests[0].posti_richiesti = 1; }],
  ['Cronologia ciclo alterata', s => { s.ciclo.evaluation.times[2] += 1000; }]
];

for (const [nome, modifica] of casi) {
  const s = scenarioValido();
  modifica(s);
  assert.throws(() => valutaEconomiaCicloFermate(s),
    /POPBUS_STOP_CYCLE_ECONOMICS:/, `Doveva essere rifiutato: ${nome}`);
  console.log(`RIFIUTATO CORRETTAMENTE: ${nome}`);
}
console.log(`TEST NEGATIVI STOP CYCLE ECONOMICS + INTEGRITA' SUPERATI (${casi.length}/${casi.length})`);
