// TURENTU POPBUS V2 — TEST 14: mapping globale / fermate / geometria
// Salvare come tests/test_popbus_mapping_globale_14.mjs
// Eseguire: node tests/test_popbus_mapping_globale_14.mjs
// SOLO LETTURA: non importa worker, DB, Stripe o socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0, gap = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '-', e.message); }
}
function finding(name, detail) { gap++; console.log('GAP', name, '—', detail); }
const root = process.cwd();
const assemblerFile = path.join(root, 'services/popbus/v2/popbus-single-corsa-assembler.js');
const acceptanceFile = path.join(root, 'services/popbus/v2/acceptance.js');
console.log('=== TURENTU POPBUS / TEST 14 MAPPING GLOBALE ===');
if (!fs.existsSync(assemblerFile)) {
  console.error('FAIL Assembler non trovato:', assemblerFile);
  process.exitCode = 1;
} else {
  const { componiCicloInCorsa } = await import(pathToFileURL(assemblerFile).href);
  const MIN = 60000;
  const BASE = Date.parse('2026-10-19T08:00:00.000Z');
  const nodi = [
    {id:7,lat:40.3515,lon:18.1750,nome_nodo:'Lecce'},
    {id:5,lat:40.1200,lon:18.3000,nome_nodo:'Maglie'},
    {id:8,lat:39.9300,lon:18.3600,nome_nodo:'Tricase'}
  ];
  const byId = new Map(nodi.map(n => [n.id,n]));
  // Polyline Google encoded con due estremi effettivi (non richiede dipendenze).
  function encNumber(value) {
    let n = Math.round(value * 1e5);
    n = n < 0 ? ~(n << 1) : n << 1;
    let out = '';
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 31)) + 63); n >>>= 5; }
    return out + String.fromCharCode(n + 63);
  }
  function encode(points) {
    let lastLat=0,lastLon=0,out='';
    for (const p of points) {
      const lat=Math.round(p.lat*1e5)/1e5, lon=Math.round(p.lon*1e5)/1e5;
      out+=encNumber(lat-lastLat)+encNumber(lon-lastLon);
      lastLat=lat;lastLon=lon;
    }
    return out;
  }
  function decode(str) {
    const numbers=[]; let pos=0;
    while(pos<str.length) {
      let result=0,shift=0,byte;
      do {
        if(pos>=str.length) throw Error('Polyline troncata');
        byte=str.charCodeAt(pos++)-63;
        result|=(byte&31)<<shift; shift+=5;
      } while(byte>=32);
      numbers.push((result&1)?~(result>>1):(result>>1));
    }
    if(numbers.length%2) throw Error('Polyline con coordinate incomplete');
    const points=[];let lat=0,lon=0;
    for(let i=0;i<numbers.length;i+=2){lat+=numbers[i];lon+=numbers[i+1];points.push({lat:lat/1e5,lon:lon/1e5});}
    return points;
  }
  function leg(a,b,mins=30) {
    return {metres:20000,seconds:mins*60,polyline:encode([byId.get(a),byId.get(b)])};
  }
  const missioni = [
    {corridorId:'m1',nodes:[7,5],legs:[leg(7,5)],departure:BASE,arrival:BASE+30*MIN,requests:[{id:101,start:0,end:1,posti_richiesti:2}]},
    {corridorId:'m2',nodes:[5,8],legs:[leg(5,8)],departure:BASE+50*MIN,arrival:BASE+80*MIN,requests:[{id:102,start:0,end:1,posti_richiesti:3}]},
    {corridorId:'m3',nodes:[8,7],legs:[leg(8,7)],departure:BASE+100*MIN,arrival:BASE+130*MIN,requests:[{id:103,start:0,end:1,posti_richiesti:2}]}
  ];
  const plan = componiCicloInCorsa({
    missioni,trasferimenti:[{seconds:0,attesaMinuti:20},{seconds:0,attesaMinuti:20}],
    nodi,veicoloId:353,postiTotali:4,
    busyStart:new Date(BASE-15*MIN).toISOString(),busyEnd:new Date(BASE+145*MIN).toISOString(),
    approach:{metres:5000,seconds:900},returnTrip:{metres:5000,seconds:900}
  });
  const requests=plan.evaluation.requests;
  const times=plan.evaluation.times;
  const stops=requests.flatMap(r=>[
    {id:r.id,tipo:'ritiro',ordine:r.start,nodo:plan.coordinates[r.start].id,orario:new Date(plan.evaluation.departure+times[r.start]).toISOString()},
    {id:r.id,tipo:'rilascio',ordine:r.end,nodo:plan.coordinates[r.end].id,orario:new Date(plan.evaluation.departure+times[r.end]).toISOString()}
  ]).sort((a,b)=>a.ordine-b.ordine || (a.tipo==='rilascio'?-1:1));

  check('Assembler reale produce una sequenza globale',()=>{
    assert.equal(plan.nodes.length,8); assert.equal(plan.legs.length,7);
    assert.equal(plan.missioni.length,3);assert.equal(plan.attivabile,false);
  });
  check('Tre richieste conservano ID e posti',()=>assert.deepEqual(requests.map(r=>[r.id,r.posti_richiesti]),[[101,2],[102,3],[103,2]]));
  check('Indici globali 0-1 / 3-4 / 6-7',()=>assert.deepEqual(requests.map(r=>[r.start,r.end]),[[0,1],[3,4],[6,7]]));
  check('Indici locali 0-1 preservati nei dati di missione',()=>assert(missioni.every(m=>m.requests[0].start===0 && m.requests[0].end===1)));
  check('Metadati missione mappano offset globale',()=>{
    assert.deepEqual(plan.missioni.map(m=>[m.ordine,m.startIndex,m.endIndex]),[[1,0,1],[2,3,4],[3,6,7]]);
    for(let i=0;i<3;i++) assert.equal(plan.missioni[i].startIndex+missioni[i].requests[0].end,requests[i].end);
  });
  check('Richieste globali puntano ai nodi corretti',()=>assert.deepEqual(requests.map(r=>[plan.nodes[r.start],plan.nodes[r.end]]),[[7,5],[5,8],[8,7]]));
  check('Ritorno sullo stesso nodo non confonde occorrenze',()=>{
    assert.equal(plan.nodes[0],plan.nodes[7]);assert.notEqual(requests[0].start,requests[2].end);
  });
  check('Attese e nodi ripetuti preservano indici distinti',()=>{
    assert.deepEqual(plan.nodes,[7,5,5,5,8,8,8,7]);
    assert.equal(plan.legs.filter(l=>l.attesa).length,2);
  });
  check('Occupazione globale, peak e totale passeggeri',()=>{
    assert.deepEqual(plan.validazioneCapienza.occupazioneSegmenti,[2,0,0,3,0,0,2]);
    assert.equal(plan.evaluation.peak,3);assert.equal(plan.validazioneCapienza.totalePasseggeri,7);
  });
  check('Orari di salita/discesa su asse globale',()=>{
    assert.deepEqual(requests.map(r=>[times[r.start]/MIN,times[r.end]/MIN]),[[0,30],[50,80],[100,130]]);
    assert.equal(times.at(-1),130*MIN);
  });
  check('Fermate globali in ordine e con orari ISO',()=>{
    assert.deepEqual(stops.map(s=>[s.id,s.tipo,s.ordine]),[
      [101,'ritiro',0],[101,'rilascio',1],[102,'ritiro',3],
      [102,'rilascio',4],[103,'ritiro',6],[103,'rilascio',7]
    ]);
    assert(stops.every(s=>Number.isFinite(Date.parse(s.orario))));
  });
  check('Intervallo busy include avvicinamento e ritorno',()=>{
    assert.equal(Date.parse(plan.busyStart),BASE-15*MIN);
    assert.equal(Date.parse(plan.busyEnd),BASE+145*MIN);
  });
  check('Geometria: legs e coordinate hanno cardinalita coerente',()=>{
    assert.equal(plan.legs.length+1,plan.coordinates.length);
    assert(plan.legs.every(l=>typeof l.polyline==='string' && l.polyline.length>0));
  });
  check('Polyline delle missioni collegano gli estremi previsti',()=>{
    for(const idx of [0,3,6]) {
      const pts=decode(plan.legs[idx].polyline);
      assert.equal(pts.length,2);
      for(const [p,n] of [[pts[0],plan.coordinates[idx]],[pts.at(-1),plan.coordinates[idx+1]]]) {
        assert(Math.abs(p.lat-n.lat)<0.00002 && Math.abs(p.lon-n.lon)<0.00002);
      }
    }
  });
  check('Polyline attesa rappresenta una sosta a lunghezza zero',()=>{
    for(const l of plan.legs.filter(l=>l.attesa)) {
      const pts=decode(l.polyline);
      assert(pts.length>=1);
      assert.equal(l.metres,0);
    }
  });
  // La acceptance attuale richiede decoded.length>=2 per OGNI leg.
  // Il test rileva esplicitamente la discrepanza, senza nasconderla.
  const onePointLegs=plan.legs.map((l,i)=>({i,points:decode(l.polyline).length,attesa:!!l.attesa})).filter(x=>x.points<2);
  if(onePointLegs.length) finding('Compatibilita acceptance: polyline a punto singolo',
    `${onePointLegs.length} leg a un punto (attese o coincidenze); acceptance attuale rifiuta decoded.length < 2. Serve gestione esplicita delle soste.`);
  else check('Tutte le polyline soddisfano minimo due punti',()=>assert.equal(onePointLegs.length,0));

  // Mapping simile a quello usato dall'acceptance per indici della polilinea.
  // E' una simulazione: non sostituisce la ricostruzione reale con turf.
  const polylineIndices=[0];let pointCount=0;
  for(const [i,l] of plan.legs.entries()) {
    const pts=decode(l.polyline);
    pointCount+=i===0?pts.length:Math.max(0,pts.length-1);
    polylineIndices.push(pointCount-1);
  }
  check('Mapping indici di nodo → indici della polilinea simulata',()=>{
    assert.equal(polylineIndices.length,plan.nodes.length);
    assert(polylineIndices.every((v,i)=>Number.isInteger(v) && v>=0 && (i===0 || v>=polylineIndices[i-1])));
  });
  check('Ogni richiesta conserva indici polilinea ordinati',()=>{
    for(const r of requests) assert(polylineIndices[r.start]<=polylineIndices[r.end]);
  });
  // Simulazione offset geodetici, non un confronto con Turf dell'acceptance.
  function distance(a,b) {
    const rad=Math.PI/180,R=6371000;
    const dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad;
    const h=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  const offsets=[0];
  for(const l of plan.legs) {
    const pts=decode(l.polyline);
    let metres=0;for(let i=1;i<pts.length;i++) metres+=distance(pts[i-1],pts[i]);
    offsets.push(offsets.at(-1)+metres);
  }
  check('Offset monotoni anche durante attese',()=>{
    assert.equal(offsets.length,plan.nodes.length);
    assert(offsets.every((v,i)=>i===0 || v>=offsets[i-1]));
    for(const i of [1,2,4,5]) assert(Math.abs(offsets[i+1]-offsets[i])<0.01);
  });
  check('Distanze per richiesta non negative e coerenti',()=>{
    for(const r of requests) assert(offsets[r.end]>offsets[r.start]);
  });
  if(fs.existsSync(acceptanceFile)) {
    const source=fs.readFileSync(acceptanceFile,'utf8');
    check('Acceptance reale presente e con guardia multi-missione',()=>{
      assert.match(source,/missioni\.length\s*>\s*1/);
      assert.match(source,/non ancora abilitata/);
    });
    if(/decoded\.length\s*<\s*2/.test(source)) {
      check('Acceptance reale richiede due punti per leg',()=>assert.match(source,/decoded\.length\s*<\s*2/));
    } else finding('Controllo geometria acceptance', 'Non rilevata guardia statica decoded.length < 2: verificare manualmente.');
  } else finding('Acceptance non trovata', 'Verificare services/popbus/v2/acceptance.js; nessuna modifica eseguita.');
  finding('Offset metrici reali', 'La verifica usa Haversine sintetico, non turf.length né routing reale: necessario test di integrazione acceptance.');
  finding('Persistenza reale indici globali', 'Mapping validato in memoria; INSERT in popbus_attivazione_richieste, corse e prenotazioni ancora non eseguiti.');
  console.log('\nRIEPILOGO',JSON.stringify({pass,fail,gap,missioni:plan.missioni.length,
    richieste:requests.map(r=>({id:r.id,indice_salita:r.start,indice_discesa:r.end,posti:r.posti_richiesti})),
    legConMenoDiDuePunti:onePointLegs,peak:plan.evaluation.peak,
    attivabile:plan.attivabile,modalita:'SOLA LETTURA / ASSEMBLER REALE / GEOMETRIA SINTETICA'},null,2));
  console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${gap} GAP. Nessuna scrittura.`);
  if(fail) process.exitCode=1;
}
