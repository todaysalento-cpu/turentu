// TURENTU PIXEL — diagnostica completezza territoriale (sola memoria)
// Copiare in tests/ e avviare: node tests\pixel_diagnostica_completezza_readonly.mjs
// Nessun accesso al database o alla rete; non modifica file di produzione.
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

const request = (id, a, b, time='2026-10-16T09:00:00Z') => ({
  id, origine_nodo_territoriale_id:a, destinazione_nodo_territoriale_id:b,
  start_datetime:time, posti_richiesti:1
});
let routingCalls=0;
const routeNodes = async nodes => {
  routingCalls++;
  return {verificataRouting:true,legs:nodes.slice(1).map((n,i)=>({
    metres:12000,seconds:1200,polyline:`mock-${nodes[i]}-${n}`
  }))};
};
const engine = () => createIncrementalCorridorEngine({routeNodes});
const nodesOf = c => c.nodes.join('>');
const idsOf = c => [...(c.richiestaIds??[])].map(String).sort();
const has = (c,id) => idsOf(c).includes(String(id));
const covers = (c,a,b) => {
  const i=c.nodes.indexOf(a),j=c.nodes.indexOf(b);
  return i>=0 && j>i;
};
const report=[];
function record(name, ok, details) {
  report.push({verifica:name,esito:ok?'OK':'LACUNA',dettaglio:details});
  console.log(`${ok?'OK':'LACUNA'} | ${name} | ${details}`);
}
function snapshot(e) {return e.listCorridors().map(c=>({nodes:nodesOf(c),ids:idsOf(c)}));}

// 1) Una estensione deve conservare le richieste del percorso originario.
{
  const e=engine();
  await e.processRequest(request(1,7,8));
  await e.processRequest(request(2,7,6));
  const extended=e.listCorridors().filter(c=>nodesOf(c)==='7>8>6');
  record('Conservazione richieste in estensione',extended.some(c=>has(c,1)&&has(c,2)),
    JSON.stringify({estese:extended.map(c=>idsOf(c)),catalogo:snapshot(e)}));
}

// 2) La medesima domanda in ordine differente non dovrebbe perdere copertura territoriale.
{
  const demand=[request(11,7,8),request(12,8,6),request(13,7,6)];
  const e1=engine(),e2=engine();
  for(const r of demand)await e1.processRequest(r);
  for(const r of [...demand].reverse())await e2.processRequest(r);
  const missing = (e) => demand.filter(r=>!e.listCorridors().some(c=>
    covers(c,r.origine_nodo_territoriale_id,r.destinazione_nodo_territoriale_id)&&has(c,r.id)))
    .map(r=>r.id);
  const m1=missing(e1),m2=missing(e2);
  record('Copertura richieste in ordini diversi',!m1.length&&!m2.length,
    JSON.stringify({ordineNormale:{mancanti:m1,catalogo:snapshot(e1)},ordineInverso:{mancanti:m2,catalogo:snapshot(e2)}}));
}

// 3) Se esistono due estensioni possibili, non fermarsi senza diagnosticare la seconda.
{
  const e=engine();
  await e.processRequest(request(21,7,8));
  await e.processRequest(request(22,7,9));
  await e.processRequest(request(23,8,10));
  await e.processRequest(request(24,9,10));
  const candidates=e.listCorridors().filter(c=>covers(c,7,10));
  const alternatives=[['7>8>10',[21,23]],['7>9>10',[22,24]]];
  const found=alternatives.map(([path,ids])=>({path,exists:candidates.some(c=>nodesOf(c)===path),
    withBoth:candidates.some(c=>nodesOf(c)===path&&ids.every(id=>has(c,id)))}));
  record('Varianti alternative convergenti',found.every(x=>x.withBoth),
    JSON.stringify({attese:found,catalogo:snapshot(e)}));
}

// 4) Inserimento intermedio: direttrice 7>6 e domanda 7>8 + 8>6.
// Non si impone che l'algoritmo trovi questa variante: si misura la lacuna.
{
  const e=engine();
  await e.processRequest(request(31,7,6));
  await e.processRequest(request(32,7,8));
  await e.processRequest(request(33,8,6));
  const composed=e.listCorridors().filter(c=>nodesOf(c)==='7>8>6');
  record('Composizione con nodo intermedio',composed.some(c=>[31,32,33].every(id=>has(c,id))),
    JSON.stringify({composte:composed.map(c=>idsOf(c)),catalogo:snapshot(e)}));
}

console.log('\nRIEPILOGO DIAGNOSTICO');
console.table(report.map(({verifica,esito})=>({verifica,esito})));
console.log(`Routing mock chiamato ${routingCalls} volte. Nessuna scrittura DB.`);
console.log('LACUNA indica requisito da valutare: non equivale automaticamente a un bug del contratto attuale.');
// Exit code 0 per consentire l'analisi completa anche quando emergono lacune.
