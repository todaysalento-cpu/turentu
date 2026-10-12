import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Esegue i servizi reali con routing e client PostgreSQL sostituiti in memoria.
const matcherSource = await readFile(new URL('../services/popbus/directiveMatcher.js', import.meta.url), 'utf8');
const matcher = await import('data:text/javascript;base64,' + Buffer.from(matcherSource.replace(
  "import { getRouteGeometry } from '../../utils/maps.util.js';",
  'const getRouteGeometry = async () => ({durata:600});'
)).toString('base64'));
const clusterSource = await readFile(new URL('../services/popbus/clusterService.js', import.meta.url), 'utf8');
const { elaboraClustering } = await import('data:text/javascript;base64,' + Buffer.from(clusterSource).toString('base64'));
const departure = '2026-10-12T17:00:00Z';
const segments = [
  {start_node_id:1,end_node_id:3,ordine_sequenziale:1,tempo_stimato:10},
  {start_node_id:3,end_node_id:4,ordine_sequenziale:2,tempo_stimato:10}
];
const request = (time, start=3, end=4) => ({start_node_id:start,end_node_id:end,start_datetime:time});

test('±30 minuti inclusivi sul transito 17:10 al nodo 3', () => {
  for (const time of ['16:40:00','17:05:00','17:40:00']) {
    assert.ok(matcher.verificaSalita(segments,departure,request(`2026-10-12T${time}Z`)));
  }
  for (const time of ['16:39:59','17:40:01','21:00:00']) {
    assert.equal(matcher.verificaSalita(segments,departure,request(`2026-10-12T${time}Z`)),null);
  }
});
test('nodo assente, ordine inverso, durata nulla e timestamp incoerente esclusi', () => {
  for (const r of [request(departure,99,4),request(departure,4,1)]) {
    assert.equal(matcher.verificaSalita(segments,departure,r),null);
  }
  assert.equal(matcher.verificaSalita([{...segments[0],tempo_stimato:null}],departure,request(departure,1,3)),null);
  assert.equal(matcher.verificaSalita([{...segments[0],start_datetime:'2026-10-12T17:05:00Z'}],departure,request(departure,1,3)),null);
});
test('clustering conserva ID e orari originali nello stesso slot', async () => {
  const rows = ['17:00:00','17:55:00'].map((t,i) => ({id:i+1,start_node_id:1,end_node_id:4,
    start_datetime:`2026-10-12T${t}Z`,posti_richiesti:2,dist_km:10}));
  const clusters = await elaboraClustering({query:async()=>({rows})});
  assert.equal(clusters.length,1);
  assert.deepEqual(clusters[0].richieste.map(r=>r.id),[1,2]);
  assert.equal(clusters[0].richieste[1].start_datetime,rows[1].start_datetime);
});
test('matcher aggiorna esclusivamente gli ID validati e conserva segmenti', async () => {
  const rows = ['17:05:00','17:55:00','21:00:00'].map((t,i)=>({id:i+1,start_node_id:1,end_node_id:3,
    start_datetime:`2026-10-12T${t}Z`,posti_richiesti:2,dist_km:10}));
  let nextDir=10, nextSeg=20;
  const dirs=[{id:1,partenza_prevista:departure}];
  const segs=new Map([[1,[{...segments[0],id:2,stato:'in_attesa',posti_impegnati:0}]]]);
  const associations=[];
  const client={query:async(sql,args=[])=>{
    assert.ok(!/DELETE FROM/i.test(sql));
    if (sql.includes('pg_advisory')) return {rows:[]};
    if (sql.includes('SELECT id, start_node_id, end_node_id, start_datetime')) return {rows:[rows.find(r=>r.id===args[0])]};
    if (sql.includes('FROM direttrici_virtuali')) return {rows:[...dirs]};
    if (sql.includes('FROM segmenti')) return {rows:segs.get(args[0])};
    if (sql.includes('ST_Y')) return {rows:args[0].map(id=>({id,lat:0,lon:0}))};
    if (sql.includes('INSERT INTO direttrici')) {
      const d={id:nextDir++,partenza_prevista:args[0]};dirs.push(d);segs.set(d.id,[]);return {rows:[d]};
    }
    if (sql.includes('INSERT INTO segmenti')) {
      const s={id:nextSeg++,start_node_id:args[1],end_node_id:args[2],ordine_sequenziale:args[3],
        tempo_stimato:args[4],start_datetime:args[5],stato:'in_attesa',posti_impegnati:0};
      segs.get(args[0]).push(s);return {rows:[{id:s.id}]};
    }
    if (sql.includes('UPDATE richieste_pop_bus')) {associations.push(args);return {rows:[{id:args[1]}]};}
    if (sql.includes('SELECT m.id') || sql.includes('UPDATE missioni') || sql.includes('UPDATE segmenti') || sql.includes('UPDATE direttrici') || sql.includes('INSERT INTO missioni')) return {rows:[]};
    throw new Error(`Query non prevista: ${sql}`);
  }};
  const clusters=await elaboraClustering({query:async()=>({rows})});
  const ids=await matcher.gestisciMatchingEDirettrici(client,clusters);
  assert.deepEqual(associations,[[1,1],[10,2],[11,3]]);
  assert.ok(ids.includes(2));
  assert.equal(segs.get(1)[0].id,2);
});
