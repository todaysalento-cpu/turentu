// TURENTU POPBUS V2 — DIAGNOSTICA SELEZIONE ECONOMICA SHADOW
// Salvare in tests/test_popbus_v2_selezione_economica_shadow.js
// NON importa worker.js, NON interroga DB, NON scrive nulla.
// Analizza il comportamento ATTUALE di scegliAttivazioni() confrontandolo
// con il riferimento economico cycle-pricing.js. I disallineamenti noti
// vengono SEGNALATI, non mascherati come test superati.
import assert from 'node:assert/strict';
import { scegliAttivazioni } from '../services/popbus/v2/model.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';

const FUTURE = Date.now() + 24 * 3600_000;
const H = 3600_000;
let ok = 0, discrepancies = 0;
function check(label, fn) {
  try { fn(); ok++; console.log(`✅ ${label}`); }
  catch (e) { console.error(`❌ ${label}: ${e.message}`); process.exitCode = 1; }
}
function gap(label, condition, details) {
  if (condition) { discrepancies++; console.log(`⚠️ DISALLINEAMENTO CONFERMATO: ${label}${details ? ' — ' + details : ''}`); }
  else console.log(`🟢 Nessun disallineamento: ${label}`);
}
function candidate(id, revenue, cost, opts={}) {
  return {
    plan: { nodes: opts.nodes || [id * 10 + 1, id * 10 + 2], classe: opts.classe || 'EXPRESS' },
    vehicle: { id: opts.vehicle ?? id, posti_totali: opts.cap ?? 4 },
    evaluation: {
      revenue, peak: opts.peak ?? 1,
      requests: (opts.requests || [id]).map(rid => ({ id: rid }))
    },
    cost,
    busyStart: opts.start ?? FUTURE,
    busyEnd: opts.end ?? FUTURE + H
  };
}
function economy(c, { kmAvvicinamento=0, kmMissioni=c.cost, kmRitornoBase=0, euroKm=1 }={}) {
  return valutaEconomiaCiclo({
    ricaviRichiesteEuro: [c.evaluation.revenue],
    kmAvvicinamento, kmMissioni, kmTrasferimenti:0, kmRitornoBase,
    euroKm
  });
}
const selected = cs => scegliAttivazioni(cs);

check('01 — Selezione legacy: candidata redditizia', () => {
  assert.equal(selected([candidate(1,120,80)]).length,1);
});
check('02 — Esclusione legacy: ricavo lordo sotto costo', () => {
  assert.equal(selected([candidate(2,70,80)]).length,0);
});
check('03 — Pricing: commissione 15% su 90 euro', () => {
  const e=economy(candidate(3,90,80));
  assert.equal(e.commissioneTurentuEuro,13.5);
  assert.equal(e.margineEuro,-3.5);
  assert.equal(e.economicamenteAttivabile,false);
});
check('04 — Pricing: 100 euro coprono 80 euro', () => {
  const e=economy(candidate(4,100,80));
  assert.equal(e.margineEuro,5);
  assert.equal(e.economicamenteAttivabile,true);
});
check('05 — Pricing: il ritorno incide sulla soglia', () => {
  const c=candidate(5,90,80);
  const without=economy(c,{kmMissioni:60,kmRitornoBase:0});
  const withReturn=economy(c,{kmMissioni:60,kmRitornoBase:20});
  assert.equal(without.economicamenteAttivabile,true);
  assert.equal(withReturn.economicamenteAttivabile,false);
});
check('06 — Capienza insufficiente esclusa', () => {
  assert.equal(selected([candidate(6,100,80,{peak:5,cap:4})]).length,0);
});
check('07 — Stessa richiesta: una sola selezione', () => {
  const cs=[candidate(7,100,80,{requests:[701]}),candidate(8,120,80,{requests:[701]})];
  assert.equal(selected(cs).length,1);
});
check('08 — Stesso veicolo, intervalli sovrapposti: una sola selezione', () => {
  const cs=[candidate(9,100,80,{vehicle:42}),candidate(10,110,80,{vehicle:42})];
  assert.equal(selected(cs).length,1);
});
check('09 — Stesso veicolo, intervalli separati: due selezioni', () => {
  const cs=[candidate(11,100,80,{vehicle:42}),candidate(12,110,80,{vehicle:42,start:FUTURE+2*H,end:FUTURE+3*H})];
  assert.equal(selected(cs).length,2);
});
check('10 — Veicoli distinti e richieste distinte: due selezioni', () => {
  assert.equal(selected([candidate(13,100,80),candidate(14,110,80)]).length,2);
});
check('11 — Classi miste: selezione non filtra per classe commerciale', () => {
  const c=candidate(15,150,80,{classe:'EXPRESS',requests:[1501,1502]});
  assert.equal(selected([c]).length,1);
});
check('12 — Pricing: soglia minima precisa a centesimi', () => {
  const e=economy(candidate(16,90,80));
  assert.equal(e.sogliaAttivazioneLordaEuro,94.12);
});

// DIAGNOSTICHE DI RISCHIO — non sono asserzioni di conformità.
const loss=candidate(100,90,80);
gap('Selezione legacy accetta margine netto negativo',
  selected([loss]).length===1 && !economy(loss).economicamenteAttivabile,
  'lordo 90 €, costo 80 €, netto -3,50 €');
const equality=candidate(101,80,80);
gap('Pareggio lordo non equivale a pareggio netto',
  selected([equality]).length===1 && !economy(equality).economicamenteAttivabile);
const expensive=candidate(102,200,170,{vehicle:500,requests:[777]});
const cheaper=candidate(103,100,75,{vehicle:501,requests:[777]});
const pick=selected([expensive,cheaper])[0];
const netExp=economy(expensive).margineEuro;
const netCheap=economy(cheaper).margineEuro;
gap('Ordinamento lordo sceglie margine netto inferiore',
  pick===expensive && netCheap>netExp,
  `selezionato ${netExp} €, alternativa ${netCheap} €`);
const missingInterval=candidate(104,100,80);
delete missingInterval.busyStart;
delete missingInterval.busyEnd;
gap('Intervallo operativo assente può essere selezionato',
  selected([missingInterval]).length===1,
  'serve validazione fail-closed prima della produzione');

console.log(`\n${ok}/12 verifiche funzionali superate; ${discrepancies} disallineamenti economici/operativi rilevati.`);
console.log('SHADOW — NESSUN DB, NESSUNA ATTIVAZIONE, NESSUNA MODIFICA AI MODULI.');
if (ok!==12) process.exitCode=1;
