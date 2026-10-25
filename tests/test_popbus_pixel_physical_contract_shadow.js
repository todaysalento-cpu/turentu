// TURENTU — Test SHADOW del contratto PIXEL territoriale / POPBUS fisico.
// Esecuzione: node tests/test_popbus_pixel_physical_contract_shadow.js
// Zero import applicativi, zero DB, zero rete, zero scritture.
// Questo test certifica SOLO il contratto proposto, NON l'integrazione produttiva.
import assert from 'node:assert/strict';

const fail = (message) => { throw new Error(`CONTRATTO_FISICO: ${message}`); };
const validId = (v) => Number.isSafeInteger(v) && v > 0;
const same = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x,i)=>x===b[i]);

function verificaContratto({opportunita, missione, richieste, postiTotali}) {
  if (missione.schemaVersion !== 2 || missione.tipoItinerario !== 'FERMATE_FISICHE') fail('versione o tipo itinerario');
  const pixel = missione.pixel;
  if (!pixel || !validId(pixel.opportunitaId) || pixel.opportunitaId !== opportunita.id ||
      pixel.direttriceId !== opportunita.direttriceId || pixel.versione !== opportunita.versione ||
      pixel.engineId !== opportunita.engineId || !same(pixel.nodiTerritoriali, opportunita.nodiTerritoriali))
    fail('identita PIXEL non coerente');
  if (!Array.isArray(missione.nodes) || missione.nodes.length < 2 ||
      !missione.nodes.every(validId) || !Array.isArray(missione.legs) ||
      missione.legs.length !== missione.nodes.length - 1) fail('sequenza fisica non valida');
  if (!Number.isSafeInteger(missione.departure) || !Number.isSafeInteger(missione.arrival) ||
      missione.arrival <= missione.departure) fail('intervallo missione');
  let elapsed = 0;
  for (let i=0; i<missione.legs.length; i++) {
    const leg = missione.legs[i];
    if (!Number.isFinite(leg.seconds) || leg.seconds < 0 || !Number.isFinite(leg.metres) || leg.metres < 0)
      fail('tratta non valida');
    if (leg.tipo === 'SOSTA') {
      if (missione.nodes[i] !== missione.nodes[i+1] || leg.metres !== 0 || leg.seconds <= 0) fail('sosta non coerente');
    } else if (leg.tipo === 'STRADA') {
      if (missione.nodes[i] === missione.nodes[i+1] || leg.metres <= 0 || leg.routingVerificato !== true)
        fail('strada non verificata');
    } else fail('tipo tratta sconosciuto');
    elapsed += leg.seconds;
  }
  if (Math.abs((missione.arrival-missione.departure)/1000-elapsed)>1) fail('tempi non riconciliati');
  if (!Number.isSafeInteger(postiTotali) || postiTotali < 1) fail('capienza veicolo');
  const allowed = new Set(opportunita.richiestaIds);
  const byId = new Map(richieste.map(r=>[r.id,r]));
  if (byId.size !== richieste.length) fail('richieste DB duplicate');
  const occupied = new Array(missione.nodes.length-1).fill(0);
  const seen = new Set();
  for (const r of missione.requests) {
    const db = byId.get(r.id);
    if (!validId(r.id) || seen.has(r.id) || !allowed.has(r.id) || !db ||
        !validId(db.posti_richiesti)) fail('richiesta non associata a PIXEL');
    seen.add(r.id);
    if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) ||
        r.start < 0 || r.start >= r.end || r.end >= missione.nodes.length ||
        missione.nodes[r.start] !== db.fermataSalitaId || missione.nodes[r.end] !== db.fermataDiscesaId)
      fail('indici fisici non coerenti');
    // Il tempo di salita e' il timestamp all'indice fisico, non l'offset territoriale.
    const salitaMs = missione.departure + missione.legs.slice(0,r.start).reduce((s,l)=>s+l.seconds*1000,0);
    if (Math.abs(salitaMs-db.orarioSalitaMs)>db.tolleranzaMs) fail('orario salita fisico incompatibile');
    for (let i=r.start;i<r.end;i++) occupied[i] += db.posti_richiesti;
  }
  if (seen.size !== richieste.length) fail('richieste missione incomplete');
  const peak = Math.max(...occupied);
  if (peak > postiTotali) fail('capienza superata');
  return {ok:true,territoriale:pixel.nodiTerritoriali,fermateFisiche:missione.nodes,peak,
    richieste:seen.size,dbWrites:0,attivabile:false};
}

const base = {
  opportunita:{id:123,direttriceId:456,versione:3,engineId:'pixel:maglie:example',nodiTerritoriali:[5,5],richiestaIds:[900001]},
  missione:{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE',
    pixel:{opportunitaId:123,direttriceId:456,versione:3,engineId:'pixel:maglie:example',nodiTerritoriali:[5,5]},
    nodes:[14,14,15,15],
    legs:[{tipo:'SOSTA',seconds:50,metres:0},{tipo:'STRADA',seconds:138,metres:869,routingVerificato:true},
      {tipo:'SOSTA',seconds:50,metres:0}],
    departure:1800000000000,arrival:1800000238000,requests:[{id:900001,start:0,end:2}]},
  richieste:[{id:900001,posti_richiesti:2,fermataSalitaId:14,fermataDiscesaId:15,
    orarioSalitaMs:1800000000000,tolleranzaMs:30000}],postiTotali:4
};
const clone = () => structuredClone(base);
let passed = 0;
function ok(name, mutate, expectedFailure=false) {
  const data=clone(); mutate?.(data);
  if (expectedFailure) assert.throws(()=>verificaContratto(data), /CONTRATTO_FISICO:/);
  else assert.equal(verificaContratto(data).ok,true);
  passed++;console.log(`PASS ${passed} - ${name}`);
}
console.log('=== TURENTU - CONTRATTO FISICO/TERRITORIALE SHADOW ===');
ok('contratto positivo: identita PIXEL e fermate distinte');
ok('versione PIXEL modificata', d=>{d.missione.pixel.versione=4},true);
ok('nodi territoriali alterati', d=>{d.missione.pixel.nodiTerritoriali=[14,15]},true);
ok('opportunita PIXEL diversa', d=>{d.missione.pixel.opportunitaId=999},true);
ok('richiesta non associata a opportunita', d=>{d.opportunita.richiestaIds=[]},true);
ok('indice salita/discesa non corrisponde alla fermata', d=>{d.missione.requests[0].start=1},true);
ok('sosta fisica mancante', d=>{d.missione.legs[0].seconds=0},true);
ok('tempo totale incoerente', d=>{d.missione.arrival+=60000},true);
ok('routing stradale non verificato', d=>{d.missione.legs[1].routingVerificato=false},true);
ok('orario salita fisico incompatibile', d=>{d.richieste[0].orarioSalitaMs+=120000},true);
ok('capienza sequenziale superata', d=>{d.postiTotali=1},true);
ok('richiesta duplicata', d=>{d.missione.requests.push({...d.missione.requests[0]})},true);
console.log(`RISULTATO: ${passed}/12 test superati; DB writes: 0; LIVE: NO`);
