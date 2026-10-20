/**
 * TURENTU P0-C8.17B — assembler -> adapter -> persistenza PIXEL, ROLLBACK ONLY.
 * DIAGNOSTICO: l'economia positiva e' un MOCK CONTRATTUALE, NON una valutazione reale.
 * Le polilinee sono SEGNAPOSTO: nessuna geometria di questo test e' operativa.
 * Non chiamare acceptance, Stripe, routing, non generare offerte, non aggiornare richieste.
 * Non eseguire in produzione. Eseguire su DB di collaudo, senza worker concorrenti.
 * node --env-file=.env tests/test_pixel_popbus_p0_c8_17b_integrato_rollback.mjs
 */
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';
import { validaPianoMultiMissione } from '../services/popbus/v2/popbus-multimission-preflight.js';
import { preparaCicloPixelPerPersistenza } from '../services/popbus/v2/popbus-p0-c8-adapter.js';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';

const pass = x => console.log('PASS', x);
const ms = x => Date.parse(x);
const start1 = ms('2026-11-01T13:00:00Z');
const start2 = ms('2026-11-01T15:15:00Z');
const ids1 = [196,197,198], ids2 = [205,206,207], ids = [...ids1,...ids2];
const nodeIds = [8,5,7];
const secs1 = 1714, secs2 = 1901, secsTransfer = 2856;
const missionDuration = (secs1+secs2)*1000;
const waitMinutes = (start2-start1-missionDuration-secsTransfer*1000)/60000;
const fakePolyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const leg = (metres,seconds) => ({metres,seconds,polyline:fakePolyline,fixtureOnly:true});
const missionLegs = [leg(24459,secs1),leg(31364,secs2)];
const localIndices = (r) => {
  const s=nodeIds.indexOf(Number(r.origine_nodo_territoriale_id));
  const e=nodeIds.indexOf(Number(r.destinazione_nodo_territoriale_id));
  assert(s>=0 && e>s, `Nodi richiesta ${r.id} non coerenti`);
  return {id:Number(r.id),start:s,end:e,posti_richiesti:Number(r.posti_richiesti)};
};
const sorted = a => a.map(Number).sort((a,b)=>a-b);
const expectSame = (a,b) => assert.deepEqual(a,b);
let client, tx=false, activationId=null, failure=null;
console.log('\n=== P0-C8.17B / ASSEMBLER -> ADAPTER -> DB / ROLLBACK ONLY ===');
console.log('ATTENZIONE: mock economico POSITIVO SOLO per collaudo contrattuale; ciclo reale NON attivabile.');
try {
  client=await pool.connect();
  await client.query('BEGIN'); tx=true;
  await client.query("SET LOCAL statement_timeout = '20000ms'");
  await client.query("SET LOCAL lock_timeout = '5000ms'");

  const {rows: opp}=await client.query(`
    SELECT o.id,o.stato,o.direttrice_id,d.stato AS direttrice_stato,d.nodi,d.engine_id,d.versione
      FROM public.pixel_opportunita o JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
     WHERE o.id = ANY($1::bigint[]) ORDER BY o.id`, [[118,120]]);
  assert.equal(opp.length,2);
  for(const o of opp){
    assert.equal(o.stato,'candidata'); assert.equal(o.direttrice_stato,'attiva');
    expectSame(o.nodi.map(Number),nodeIds);
  }
  const oppMap=new Map(opp.map(o=>[Number(o.id),o]));
  pass('Opportunita PIXEL 118/120 candidate, direttrici attive e nodi coerenti');

  const {rows: assocs}=await client.query(`SELECT opportunita_id,richiesta_id FROM public.pixel_opportunita_richieste
     WHERE opportunita_id = ANY($1::bigint[])`, [[118,120]]);
  for(const [op,reqs] of [[118,ids1],[120,ids2]]){
    const allowed=new Set(assocs.filter(a=>Number(a.opportunita_id)===op).map(a=>Number(a.richiesta_id)));
    assert(reqs.every(id=>allowed.has(id)),`Richieste non associate a opportunita ${op}`);
  }
  const {rows: realRows}=await client.query(`
    SELECT id,cliente_id,stato,corsa_id,prezzo,posti_richiesti,start_datetime,
           origine_nodo_territoriale_id,destinazione_nodo_territoriale_id
      FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[ids]);
  assert.equal(realRows.length,6);
  assert(realRows.every(r=>r.stato==='in_attesa' && r.corsa_id==null));
  const realById=new Map(realRows.map(r=>[Number(r.id),r]));
  const {rows: veh}=await client.query('SELECT id,driver_id,posti_totali FROM public.veicolo WHERE id=$1',[353]);
  assert.equal(veh.length,1); assert(Number(veh[0].driver_id)>0 && Number(veh[0].posti_totali)>=2);
  const vehicle=veh[0];
  // Coordinate dei nodi gia' verificate nei precedenti test P0-C8.7B.
  // Sono solo input di composizione: nessuna rotta o polilinea reale viene certificata.
  const nodeCatalog=[
    {id:8,lat:39.9302065,lon:18.3584374},
    {id:5,lat:40.117872,lon:18.298862},
    {id:7,lat:40.3522,lon:18.1755}
  ];
  const makeMission=(reqIds,start,corridorId)=>({
    nodes:nodeIds,legs:missionLegs,departure:start,arrival:start+missionDuration,corridorId,
    requests:reqIds.map(id=>localIndices(realById.get(id)))
  });
  const missions=[makeMission(ids1,start1,oppMap.get(118).engine_id),makeMission(ids2,start2,oppMap.get(120).engine_id)];
  const plan=componiCicloInCorsa({missioni:missions,
    trasferimenti:[{...leg(53029,secsTransfer),attesaMinuti:waitMinutes}],
    nodi:nodeCatalog,veicoloId:Number(vehicle.id),postiTotali:Number(vehicle.posti_totali),
    busyStart:new Date(start1-3600000).toISOString(),busyEnd:new Date(start2+missionDuration+3600000).toISOString(),
    approach:{metres:0,seconds:0},returnTrip:{metres:0,seconds:0}
  });
  assert.equal(plan.nodes.length,7); assert.equal(plan.missioni.length,2);
  assert.equal(plan.evaluation.peak,2); assert.equal(plan.validazioneCapienza.totalePasseggeri,6);
  validaPianoMultiMissione(plan,{veicoloId:Number(vehicle.id),postiTotali:Number(vehicle.posti_totali)});
  pass('Assembler e preflight reali: 7 nodi, trasferimento+attesa, 6 trasportati, picco 2');

  // Gate economico REALE: il fixture da EUR 60 e' insufficiente, dunque rifiuto atteso.
  const realGross=realRows.reduce((sum,r)=>sum+Number(r.prezzo),0);
  assert.equal(realGross,60);
  const minKm=(2*(24459+31364)+53029)/1000;
  const costAt060=minKm*0.60;
  assert(costAt060>realGross*0.85);
  // Le richieste DB non sono mutate: sono in_attesa e prive di cliente_id.
  const diagnosticRows=realRows.map(r=>({...r}));
  const opts={plan,richiesteBloccate:diagnosticRows,
    opportunitaMissioni:[{pixelOpportunitaId:118},{pixelOpportunitaId:120}],
    veicoloId:Number(vehicle.id),postiTotali:Number(vehicle.posti_totali),
    fingerprintRichiesta:r=>`TEST_ONLY_${r.id}`};
  assert.throws(()=>preparaCicloPixelPerPersistenza({...opts,economia:{economicamenteAttivabile:false}}),/economicamente attivabile/);
  pass('Adapter rifiuta correttamente economia reale negativa (nessuna autorizzazione)');

  // Da qui in avanti: SOLO mock contrattuale, dentro una transazione destinata a ROLLBACK.
  // Nessun dato delle richieste DB viene modificato: la simulazione resta in memoria.
  const simulated=realRows.map(r=>({...r,stato:'in_lavorazione',cliente_id:4,corsa_id:null}));
  assert(simulated.every(r=>r.stato==='in_lavorazione' && Number(r.cliente_id)>0));
  const prepared=preparaCicloPixelPerPersistenza({...opts,richiesteBloccate:simulated,
    economia:{economicamenteAttivabile:true,fixtureOnly:true}});
  assert.equal(prepared.piano.attivabile,false);
  assert.equal(prepared.piano.requestSnapshot.length,6);
  expectSame(prepared.missioniPersistibili.map(m=>m.pixelOpportunitaId),[118,120]);
  expectSame(prepared.missioniPersistibili.map(m=>m.requests.map(r=>r.id)),[ids1,ids2]);
  pass('Adapter produce mapping e snapshot SOLO con input sintetici dichiarati');

  // Arricchimento metadati opzionali PIXEL letti dal DB, senza ricalcolare mapping.
  const missioniPersistibili=prepared.missioniPersistibili.map((m,i)=>{
    const o=oppMap.get(i===0?118:120);
    return {...m,pixelDirettriceId:Number(o.direttrice_id),pixelVersione:Number(o.versione),
      corridoioPixelId:String(o.engine_id)};
  });
  const fixturePlan={...prepared.piano,fixtureOnly:true,
    TEST_ONLY_ECONOMY_MOCK:true,TEST_ONLY_POLYLINE_PLACEHOLDER:true,
    economia:{economicamenteAttivabile:false,nota:'Ciclo reale non sostenibile; mock solo per test contratto'}};
  const {rows: inserted}=await client.query(`
    INSERT INTO public.popbus_attivazioni
      (direttrice_id,pixel_opportunita_id,veicolo_id,autista_id,stato,
       partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
    VALUES (NULL,$1,$2,$3,'in_attesa_autista',$4,$5,$6,$7,$8,$9::jsonb,NOW()+INTERVAL '5 minutes')
    RETURNING id`,[118,Number(vehicle.id),Number(vehicle.driver_id),new Date(start1),
      new Date(start2+missionDuration),Number(costAt060.toFixed(2)),realGross,0.60,JSON.stringify(fixturePlan)]);
  activationId=inserted[0]?.id;
  assert(activationId!=null);
  const persistedIds=await registraMissioniAttivazione(client,{
    attivazioneId:activationId,missioni:missioniPersistibili,pianoGlobale:fixturePlan});
  assert.equal(persistedIds.length,2);
  pass('Persistenza transitoria: due missioni dall’ADAPTER sotto una attivazione');

  const {rows: local}=await client.query(`SELECT mr.richiesta_id,m.ordine,m.pixel_opportunita_id,
      mr.indice_salita,mr.indice_discesa
    FROM public.popbus_missione_richieste mr JOIN public.popbus_attivazione_missioni m ON m.id=mr.missione_id
    WHERE m.attivazione_id=$1 ORDER BY m.ordine,mr.richiesta_id`,[activationId]);
  const {rows: global}=await client.query(`SELECT richiesta_id,indice_salita,indice_discesa
    FROM public.popbus_attivazione_richieste WHERE attivazione_id=$1`,[activationId]);
  assert.equal(local.length,6); assert.equal(global.length,6);
  expectSame(sorted(global.map(r=>r.richiesta_id)),sorted(ids));
  const globalMap=new Map(global.map(r=>[Number(r.richiesta_id),r]));
  for(const ref of prepared.piano.evaluation.requests){
    const row=globalMap.get(Number(ref.id));
    assert(row && Number(row.indice_salita)===ref.start && Number(row.indice_discesa)===ref.end);
  }
  for(let i=0;i<2;i++){
    const m=prepared.missioniPersistibili[i];
    for(const ref of m.requests){
      const row=local.find(x=>Number(x.richiesta_id)===ref.id);
      assert(row && Number(row.ordine)===i+1);
      assert.equal(Number(row.indice_salita),ref.start);
      assert.equal(Number(row.indice_discesa),ref.end);
    }
  }
  pass('DB: 6 mapping locali + 6 globali identici a quelli prodotti dall’adapter');
  const {rows: unchanged}=await client.query(`SELECT id,stato,corsa_id,cliente_id FROM public.richieste_pop_bus
    WHERE id=ANY($1::int[])`,[ids]);
  assert(unchanged.every(r=>r.stato==='in_attesa' && r.corsa_id==null && r.cliente_id==null));
  pass('Richieste originali NON modificate; nessuna offerta e nessun pagamento');
} catch(e){failure=e;console.error('FAIL P0-C8.17B:',e.stack||e.message);} finally {
  if(client){
    if(tx){try{await client.query('ROLLBACK');console.log('ROLLBACK completato');}
      catch(e){failure??=e;console.error('ERRORE ROLLBACK:',e.message);}}
    if(activationId!=null && !failure){
      try{const {rows}=await client.query('SELECT COUNT(*)::int AS n FROM public.popbus_attivazioni WHERE id=$1',[activationId]);
        assert.equal(rows[0].n,0);pass('Post-rollback: attivazione e missioni non persistenti');}
      catch(e){failure??=e;console.error('FAIL verifica rollback:',e.message);}
    }
    client.release(failure?new Error('Connessione scartata per precauzione'):undefined);
  }
  await pool.end();
}
if(failure)process.exitCode=1;
else console.log('ESITO: PASS — integrazione CONTRATTUALE in ROLLBACK; NON validazione economica, routing o acceptance.');
