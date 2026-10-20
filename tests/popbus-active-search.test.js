import test from 'node:test';
import assert from 'node:assert/strict';
import polyline from '@mapbox/polyline';
import { piccoOccupazione, valutaPopbusAttivata, cercaPopbusAttivate } from '../services/search/popbus-active-search.service.js';

const base = new Date(Date.now() + 2 * 3600_000);
const iso = ms => new Date(ms).toISOString();
const start = base.getTime();
const points = [[40.0, 18.0], [40.01, 18.0], [40.02, 18.0], [40.03, 18.0]];
const corsa = {
  id: 123, veicolo_id: 9, tipo_corsa: 'riempimento', stato: 'prenotabile',
  attivazione_stato: 'confermata', attivazione_id: 44,
  posti_totali: 4,
  start_datetime: iso(start), arrivo_datetime: iso(start + 30 * 60000),
  percorso_polyline: polyline.encode(points),
  fermate_pianificate: [
    {lat:40.01,lon:18.0,ordine:1,orario:iso(start+10*60000)},
    {lat:40.02,lon:18.0,ordine:2,orario:iso(start+20*60000)},
  ],
};
const richiesta = {
  lat:40.01, lon:18, destLat:40.02, destLon:18,
  start_datetime:iso(start+10*60000), posti_richiesti:2,
};

test('picco per intervallo: esclusione tratte esterne e coincidenza estremi', () => {
  const p = [
    {start_offset:0,end_offset:100,posti_richiesti:4},
    {start_offset:100,end_offset:200,posti_richiesti:1},
  ];
  assert.equal(piccoOccupazione(p,100,200),1);
  assert.equal(piccoOccupazione(p,50,150),4);
  assert.equal(piccoOccupazione(p,200,300),0);
});

test('POPBUS confermata compatibile', () => {
  const result = valutaPopbusAttivata(corsa, [], richiesta);
  assert.ok(result);
  assert.equal(result.corsa_id,123);
  assert.equal(result.posti_disponibili_tratta,4);
  assert.equal(result.prezzo_da_calcolare,true);
});

test('scarta occupazione piena, ordine invertito e attivazione non confermata', () => {
  const candidate = valutaPopbusAttivata(corsa, [], richiesta);
  assert.ok(candidate);
  const p = [{start_offset:candidate.start_offset,end_offset:candidate.end_offset,posti_richiesti:3}];
  assert.equal(valutaPopbusAttivata(corsa,p,richiesta),null);
  assert.equal(valutaPopbusAttivata(corsa,[],{...richiesta,lat:40.02,destLat:40.01}),null);
  assert.equal(valutaPopbusAttivata({...corsa,attivazione_stato:'proposta'},[],richiesta),null);
});

test('scarta orario fuori tolleranza e offset prenotazione invalidi', () => {
  assert.equal(valutaPopbusAttivata(corsa,[],{...richiesta,start_datetime:iso(start+100*60000)}),null);
  assert.equal(valutaPopbusAttivata(corsa,[{start_offset:null,end_offset:2000,posti_richiesti:1}],richiesta),null);
});

test('ricerca read-only: solo due SELECT, senza scritture', async () => {
  const queries=[];
  const pool={query:async (sql,params)=>{
    queries.push(sql);
    if(sql.includes('FROM corse c')) return {rows:[corsa]};
    return {rows:[]};
  }};
  const results=await cercaPopbusAttivate({pool,richiesta});
  assert.equal(results.length,1);
  assert.equal(queries.length,2);
  assert.ok(queries.every(q=>/^\s*SELECT\b/i.test(q)));
});
