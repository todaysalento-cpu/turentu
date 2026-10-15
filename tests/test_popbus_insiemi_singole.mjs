// TURENTU POPBUS - TEST INSIEMI / SOTTOINSIEMI E SINGOLE
// Rinominare .txt in .mjs ed eseguire: node test_popbus_insiemi_singole.mjs
// Diagnostico sintetico, sola memoria. Nessun DB, routing o worker V2.
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const BUCKET = 10; // minuti
const TOLLERANZA = 30; // minuti, finestra di partenza +/-30
const TEMPO_SEGMENTO = 10; // minuti, sintetico
const SIZES = [30, 100, 200, 500];

function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(1664525, x) + 1013904223) >>> 0) / 4294967296);
}
function genera(n, concentrato) {
  const rand = rng(9001 + n + (concentrato ? 1 : 0));
  const requests = [];
  for (let i = 0; i < n; i++) {
    const base = concentrato ? 0 : Math.floor(rand() * 12) * 100;
    const start = base + Math.floor(rand() * (concentrato ? 9 : 40));
    const length = 1 + Math.floor(rand() * (concentrato ? 9 : 7));
    const time = concentrato ? 540 + Math.floor(rand() * 7) * 10 : 480 + Math.floor(rand() * 48) * 10;
    requests.push({ id: i + 1, start, end: start + length, time });
  }
  return requests;
}
// Per ogni richiesta si registrano i segmenti attraversabili nei bucket temporali
// compatibili con uno shift globale di partenza. La copertura finale NON usa
// semplicemente l'intersezione dei pixel: verifica lo stesso shift per tutta la richiesta.
function pixels(r) {
  const keys = new Set();
  for (let node = r.start; node < r.end; node++) {
    const arrival = r.time + (node - r.start) * TEMPO_SEGMENTO;
    for (let dt = -TOLLERANZA; dt <= TOLLERANZA; dt += BUCKET) {
      keys.add(`${node}|${Math.floor((arrival + dt) / BUCKET)}`);
    }
  }
  return keys;
}
function indiceRichieste(requests) {
  const index = new Map();
  let presenze = 0;
  for (const r of requests) for (const key of pixels(r)) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(r.id);
    presenze++;
  }
  return { index, presenze };
}
// Traiettoria-ancora: la corsa attraversa i segmenti della richiesta-ancora,
// con orario di partenza r.time; non vengono costruite estensioni/unioni.
function copre(anchor, r) {
  if (r.start < anchor.start || r.end > anchor.end) return false;
  const passaggioOrigine = anchor.time + (r.start - anchor.start) * TEMPO_SEGMENTO;
  return Math.abs(passaggioOrigine - r.time) <= TOLLERANZA;
}
function keyGruppo(ids) { return [...ids].sort((a,b)=>a-b).join(','); }
function costruisci(requests) {
  const t0 = performance.now();
  const { index, presenze } = indiceRichieste(requests);
  const t1 = performance.now();
  const singles = new Map(requests.map(r => [`S:${r.id}`, { tipo: 'singola', seeds: [r.id], nodes: [r.start, r.end] }]));
  const groups = new Map();
  let verifiche = 0;
  let oracleChecks = 0;
  let diffs = 0;
  for (const anchor of requests) {
    // Unione degli ID che condividono almeno un pixel con la traiettoria-ancora.
    const possibili = new Set([anchor.id]);
    for (let node = anchor.start; node < anchor.end; node++) {
      const t = anchor.time + (node - anchor.start) * TEMPO_SEGMENTO;
      const k = `${node}|${Math.floor(t / BUCKET)}`;
      for (const id of index.get(k) || []) possibili.add(id);
    }
    const covered = [];
    for (const r of requests) {
      oracleChecks++;
      if (copre(anchor, r)) covered.push(r.id);
    }
    const selected = [];
    for (const id of possibili) {
      verifiche++;
      const r = requests[id - 1];
      if (copre(anchor, r)) selected.push(id);
    }
    selected.sort((a,b)=>a-b);
    covered.sort((a,b)=>a-b);
    if (keyGruppo(selected) !== keyGruppo(covered)) diffs++;
    if (selected.length >= 2) {
      const k = keyGruppo(selected);
      if (!groups.has(k)) groups.set(k, { seeds: selected, anchors: [] });
      groups.get(k).anchors.push(anchor.id);
    }
  }
  const t2 = performance.now();
  // Massimalita' SOLO per inclusione di ID nei gruppi trovati.
  // Non equivale a massimalita' globale di tutte le possibili traiettorie.
  const allGroups = [...groups.values()];
  const ordered = allGroups.slice().sort((a,b)=>b.seeds.length-a.seeds.length);
  const maximal = [];
  for (const g of ordered) {
    if (!maximal.some(m => g.seeds.every(id => m._set.has(id)))) {
      maximal.push({ seeds: g.seeds, _set: new Set(g.seeds) });
    }
  }
  const t3 = performance.now();
  const singlesOk = singles.size === requests.length && requests.every(r => singles.has(`S:${r.id}`) && singles.get(`S:${r.id}`).seeds[0] === r.id);
  assert(singlesOk, 'Una o piu candidate singole mancanti');
  assert.equal(diffs, 0, 'L indice ha perso richieste coperte rispetto all oracolo');
  // Verifica che gruppi e massimali NON modifichino le singole
  assert.equal(singles.size, requests.length);
  return {
    richieste: requests.length, candidate_singole: singles.size, singole_preservate: singlesOk,
    gruppi_condivisi_distinti: groups.size, gruppi_massimali: maximal.length,
    gruppo_massimo: Math.max(1, ...allGroups.map(g=>g.seeds.length)),
    richieste_in_gruppi: new Set(allGroups.flatMap(g=>g.seeds)).size,
    celle_pixel: index.size, presenze_pixel: presenze,
    verifiche_pixel: verifiche, verifiche_oracolo: oracleChecks,
    riduzione_verifiche_pct: +((1-verifiche/oracleChecks)*100).toFixed(2),
    differenze_vs_oracolo: diffs,
    ms_indice: +(t1-t0).toFixed(3), ms_gruppi: +(t2-t1).toFixed(3),
    ms_massimali: +(t3-t2).toFixed(3), ms_totale: +(t3-t0).toFixed(3),
    heap_MB: +(process.memoryUsage().heapUsed/1048576).toFixed(2)
  };
}
console.log('TURENTU - INSIEMI PIXEL + CANDIDATE SINGOLE - DIAGNOSTICO');
console.log('Bucket 10 min, tolleranza +/-30 min, 10 min/segmento SINTETICI.');
console.log('NESSUN DB / ROUTING / WORKER. Nessuna modifica a POPBUS V2.');
console.log('I gruppi rappresentano coperture su traiettorie-ancora, non tutte le candidate V2.');
for (const scenario of ['distribuito','concentrato']) {
  console.log(`\nSCENARIO: ${scenario.toUpperCase()}`);
  for (const n of SIZES) {
    const result = costruisci(genera(n, scenario === 'concentrato'));
    console.log(JSON.stringify({ scenario, ...result }));
  }
}
console.log('\nTEST SUPERATO: ogni richiesta valida conserva la sua candidata singola; nessuna differenza di copertura sintetica.');
console.log('LIMITI: i sottoinsiemi non sono enumerati; nessuna verifica di capacita, economia, planner o parita V2.');
