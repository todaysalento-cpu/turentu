/**
 * TURENTU POPBUS V2 - AUDIT COPPIE REALI / SHADOW READ ONLY
 * Salva in tests/test_popbus_v2_catene_reali_diagnostico_shadow.js
 * Esegui: node --env-file=.env tests\test_popbus_v2_catene_reali_diagnostico_shadow.js
 * Nessuna scrittura, nessuna attivazione. Il routing reale puo avere costi API.
 * Le conclusioni sulle cause sono INDIZI, non un audit interno del generatore.
 */
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';

const IDS=(process.env.POPBUS_FLEET_REQUEST_IDS||'27,28,29,31').split(',').map(Number);
if(!IDS.length||IDS.some(x=>!Number.isSafeInteger(x)||x<=0)) throw Error('IDs non validi');
const MAX_ROUTES=Number(process.env.POPBUS_FLEET_ROUTES||150);
const MAX_WAIT=Number(process.env.POPBUS_FLEET_WAIT_MIN||180);
const BUFFER=Number(process.env.POPBUS_FLEET_BUFFER_MIN||0);
const NEAR=Number(process.env.POPBUS_NEAR_TRANSFER_METRES||8);
const WAIT_COST=Number(process.env.POPBUS_COSTO_ATTESA_ORA||0);
const log=(tag,data)=>console.log(`[${tag}] ${JSON.stringify(data,null,2)}`);
const valid=p=>p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon));
const routing=new Map(), routingErrors=new Map();
let calls=0,hits=0;
async function road(a,b){
  if(!valid(a)||!valid(b))throw Error('Coordinate mancanti');
  const key=`${Number(a.lat).toFixed(7)},${Number(a.lon).toFixed(7)}>${Number(b.lat).toFixed(7)},${Number(b.lon).toFixed(7)}`;
  if(routing.has(key)){hits++;return routing.get(key);}
  if(routingErrors.has(key))throw Error(routingErrors.get(key));
  if(calls>=MAX_ROUTES)throw Error('Budget routing esaurito');
  calls++;
  try {
    const r=await leg(a,b);
    const metres=Number(r.metres),seconds=Number(r.seconds);
    if(!(metres>0&&seconds>0)&&!(r.roadCoincident===true&&metres===0&&seconds===0))
      throw Error('Routing non valido o non certificato');
    const result={metres,seconds,roadCoincident:r.roadCoincident===true};
    routing.set(key,result);return result;
  }catch(e){routingErrors.set(key,String(e.message||e));throw e;}
}
const opts={includePast:true,maxWaitMin:MAX_WAIT,bufferMin:BUFFER,maxDepth:3,
  maxChains:500,maxFormations:40,maxGroupRequests:12,maxAggregateCombos:2500,
  maxCombosPerChainVehicle:20000,maxTotalChainCombos:100000,
  nearTransferMetres:NEAR,costoAttesaOra:WAIT_COST};
let client,started=false;
try{
  client=await pool.connect();
  await client.query('BEGIN READ ONLY');started=true;
  await client.query("SET LOCAL statement_timeout='20000ms'");
  const status=(await client.query("SELECT current_setting('transaction_read_only') AS read_only,now() AS now")).rows[0];
  if(status.read_only!=='on')throw Error('READ ONLY non attivo');
  log('CATENE_REAL_DB',{read_only:status.read_only,ids:IDS,modalita:'SHADOW'});
  const {rows:requests}=await client.query(`SELECT r.* FROM public.richieste_pop_bus r
    WHERE r.id=ANY($1::int[]) AND r.stato='in_attesa' AND r.corsa_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.popbus_attivazione_richieste ar
      WHERE ar.richiesta_id=r.id AND ar.attiva)
    ORDER BY r.start_datetime,r.id`,[IDS]);
  const nodeIds=[...new Set(requests.flatMap(r=>[Number(r.start_node_id),Number(r.end_node_id)]))];
  const {rows:nodes}=await client.query(`SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,
    ST_X(posizione::geometry) AS lon FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[nodeIds]);
  const nmap=new Map(nodes.filter(valid).map(n=>[Number(n.id),n]));
  const usable=requests.filter(r=>nmap.has(Number(r.start_node_id))&&nmap.has(Number(r.end_node_id))&&
    Number(r.posti_richiesti)>0&&Number.isFinite(Number(r.prezzo))&&Number.isFinite(Date.parse(r.start_datetime)));
  const {rows:rawVehicles}=await client.query(`SELECT v.id,v.driver_id,v.posti_totali,v.raggio_km,t.euro_km,
    dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
    ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
    ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
    FROM public.veicolo v JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
    JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM public.tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
    WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
      AND COALESCE(dv.coord,v.coord) IS NOT NULL ORDER BY t.euro_km,v.id`);
  const vehicles=rawVehicles.filter(v=>valid(v)&&Number(v.posti_totali)>0&&Number(v.euro_km)>0);
  log('CATENE_REAL_INPUT',{richieste_trovate:requests.length,richieste_utilizzabili:usable.length,
    richieste_mancanti:IDS.filter(id=>!usable.some(r=>Number(r.id)===id)),veicoli:vehicles.length,
    richieste:usable.map(r=>({id:Number(r.id),partenza:new Date(r.start_datetime).toISOString(),
      origine:Number(r.start_node_id),destinazione:Number(r.end_node_id),
      posti:Number(r.posti_richiesti),prezzo:Number(r.prezzo)}))});
  if(usable.length<2||!vehicles.length)throw Error('Servono almeno due richieste utilizzabili e un veicolo');
  opts.now=Date.parse(status.now);
  const rows=[];
  for(let i=0;i<usable.length;i++)for(let j=i+1;j<usable.length;j++){
    const pair=[usable[i],usable[j]];
    const [a,b]=pair;
    const startGapMin=(Date.parse(b.start_datetime)-Date.parse(a.start_datetime))/60000;
    let transfer=null,transferError=null;
    try {const x=await road(nmap.get(Number(a.end_node_id)),nmap.get(Number(b.start_node_id)));
      transfer={km:x.metres/1000,minuti:x.seconds/60};}
    catch(e){transferError=String(e.message||e);}
    let real=null,symbolic=null,error=null;
    try {
      const input={requests:pair,nodes:nodes.filter(valid),vehicles,road};
      real=await generaCandidatiFlotta(input,opts);
      symbolic=await generaCandidatiFlotta({...input,vehicles:vehicles.map(v=>({...v,euro_km:0.000001}))},opts);
    }catch(e){error=String(e.stack||e);}
    const chains=x=>(x?.candidati||[]).filter(c=>Array.isArray(c.richieste)&&c.richieste.length>=2)
      .map(c=>({veicolo:Number(c.veicolo),richieste:c.richieste,
        km:Number(c.km_totali),ricavo:Number(c.ricavo_euro),margine_generatore:Number(c.margine_ciclo_con_attesa_euro)}));
    const economic=chains(real),structural=chains(symbolic);
    rows.push({coppia:pair.map(r=>Number(r.id)),partenze_utc:pair.map(r=>new Date(r.start_datetime).toISOString()),
      differenza_partenze_min:startGapMin,trasferimento_dopo_prima:transfer,
      errore_trasferimento:transferError,nota_temporale:'La differenza fra partenze NON e il tempo disponibile: manca la durata della prima missione.',
      gruppi_reali:real?.diagnostica?.gruppi??null,missioni_reali:real?.diagnostica?.missioni??null,
      catene_reali:real?.diagnostica?.catene??null,
      catene_simboliche:symbolic?.diagnostica?.catene??null,
      candidati_catena_reali:economic.slice(0,10),candidati_catena_simbolici:structural.slice(0,10),
      avvertenza:'Le catene simboliche NON sono sostenibili alla tariffa reale. Zero catene non identifica univocamente il vincolo.',
      errore_generazione:error});
  }
  log('CATENE_REAL_COPPIE',rows);
  log('CATENE_REAL_RIEPILOGO',{coppie:rows.length,con_catene_reali:rows.filter(r=>r.catene_reali>0).length,
    con_catene_simboliche:rows.filter(r=>r.catene_simboliche>0).length,
    errori_generazione:rows.filter(r=>r.errore_generazione).length,
    chiamate_routing:calls,cache_hit:hits,errori_routing:[...routingErrors.values()],
    nota:'Diagnostica per coppie, NON certificazione produttiva. I casi senza catene richiedono audit dei vincoli interni.'});
}catch(e){console.error('[CATENE_REAL_ERRORE]',e.stack||e.message);process.exitCode=1;}
finally{
  if(started)try{await client.query('ROLLBACK');console.log('[CATENE_REAL_ROLLBACK] OK');}
    catch(e){console.error('[CATENE_REAL_ROLLBACK_ERRORE]',e.message);process.exitCode=1;}
  if(client)client.release();
  try{await pool.end();}catch(e){console.error('[CATENE_REAL_POOL_ERRORE]',e.message);process.exitCode=1;}
}
