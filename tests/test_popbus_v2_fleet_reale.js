/**
 * TURENTU POPBUS V2 - FLEET REALE (SHADOW / READ ONLY)
 * node --env-file=.env tests/test_popbus_v2_fleet_reale.js
 *
 * Legge dati reali in transazione READ ONLY. Non modifica il worker e non
 * attiva corse. Il routing esistente può comportare costi Google Maps.
 *
 * NON certifica la compatibilità commerciale: pagamenti, qualità, soglie di
 * classe (con costo ritorno incluso), turni, raggio e conflitti DB richiedono
 * validatori produttivi. Il confronto 10B richiede identico snapshot.
 */
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.js';

function bounded(key, fallback, min, max) {
  const n=Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? Math.max(min,Math.min(max,Math.trunc(n))) : fallback;
}
const LIMIT=bounded('POPBUS_FLEET_REQUESTS',40,1,120);
const MAX_ROUTES=bounded('POPBUS_FLEET_ROUTES',100,1,300);
const MAX_WAIT=bounded('POPBUS_FLEET_WAIT_MIN',180,0,720);
const BUFFER=bounded('POPBUS_FLEET_BUFFER_MIN',0,0,120);
const MAX_CHAINS=bounded('POPBUS_CYCLE_MAX_CHAINS',500,1,5000);
const MAX_FORMATIONS=bounded('POPBUS_CYCLE_FORMATIONS',8,1,2500);
const MAX_DEPTH=bounded('POPBUS_CYCLE_DEPTH',3,2,3);
const MAX_GROUP=bounded('POPBUS_TEST10_MAX_GROUP_REQUESTS',12,1,20);
const MAX_AGGREGATE=bounded('POPBUS_TEST10_MAX_AGGREGATE',2500,1,100000);
const MAX_COMBOS=bounded('POPBUS_TEST10B_MAX_COMBOS',20000,1,200000);
const MAX_TOTAL=bounded('POPBUS_TEST10B_MAX_TOTAL',100000,1,1000000);
const OPT_NODES=bounded('POPBUS_OPT_MAX_NODES',250000,1,3000000);
const OPT_CANDIDATES=bounded('POPBUS_OPT_MAX_CANDIDATES',5000,1,30000);
const NEAR=bounded('POPBUS_NEAR_TRANSFER_METRES',8,0,30);
const WAIT_COST=Math.max(0,Number(process.env.POPBUS_COSTO_ATTESA_ORA ?? 0)||0);
const INCLUDE_PAST=process.env.POPBUS_CYCLE_INCLUDE_PAST==='1';
const log=(name,obj)=>console.log(`[${name}] ${JSON.stringify(obj,null,2)}`);
const finite=(x)=>Number.isFinite(Number(x));
const validCoord=p=>p&&finite(p.lat)&&finite(p.lon)&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lon))<=180;
const routeCache=new Map();
const routeErrors=new Map();
let routeCalls=0,cacheHits=0,budgetHits=0;
async function road(a,b,context) {
  if(!validCoord(a)||!validCoord(b))throw Error('Coordinate routing non valide');
  const key=`${Number(a.lat).toFixed(7)},${Number(a.lon).toFixed(7)}>${Number(b.lat).toFixed(7)},${Number(b.lon).toFixed(7)}`;
  if(routeCache.has(key)){cacheHits++;return routeCache.get(key);}
  if(routeErrors.has(key))throw Error(routeErrors.get(key));
  if(routeCalls>=MAX_ROUTES){budgetHits++;throw Error(`Budget routing ${MAX_ROUTES} esaurito`);}
  routeCalls++;
  try {
    const r=await leg(a,b);
    if(!(Number(r.metres)>0&&Number(r.seconds)>0))throw Error('Routing non valido');
    const result={metres:Number(r.metres),seconds:Number(r.seconds)};
    routeCache.set(key,result);
    return result;
  }catch(e){routeErrors.set(key,String(e.message||e));throw e;}
}
function selectedSummary(result) {
  return result.selezionati.map(c=>({
    veicolo:c.veicolo,richieste:c.richieste,
    partenza_base:c.partenza_base,ritorno_base:c.ritorno_base,
    ricavo_euro:c.ricavo_euro,costo_completo_euro:c.costo_completo_euro,
    costo_attesa_euro:c.costo_attesa_euro,
    margine_euro:c.margine_ciclo_con_attesa_euro
  }));
}
let client,started=false;
try {
  client=await pool.connect();
  await client.query('BEGIN READ ONLY');started=true;
  await client.query("SET LOCAL statement_timeout='20000ms'");
  const state=(await client.query("SELECT current_database() AS db,current_setting('transaction_read_only') AS read_only,now() AS now")).rows[0];
  if(state.read_only!=='on')throw Error('Transazione non read-only');
  log('FLEET_REALE_CONNESSIONE',state);
  const {rows:raw}=await client.query(`
    SELECT r.* FROM public.richieste_pop_bus r
    WHERE r.stato='in_attesa' AND r.corsa_id IS NULL
      AND ($1::boolean OR r.start_datetime>NOW())
      AND NOT EXISTS (
        SELECT 1 FROM public.popbus_attivazione_richieste ar
        WHERE ar.richiesta_id=r.id AND ar.attiva
      )
    ORDER BY r.start_datetime,r.id LIMIT $2`,[INCLUDE_PAST,LIMIT]);
  const requests=raw.filter(r=>finite(r.posti_richiesti)&&Number(r.posti_richiesti)>0&&
    finite(r.prezzo)&&Number(r.prezzo)>=0&&Number.isFinite(new Date(r.start_datetime).getTime()));
  const ids=[...new Set(requests.flatMap(r=>[Number(r.start_node_id),Number(r.end_node_id)]))]
    .filter(Number.isSafeInteger);
  const {rows:nodes}=await client.query(`
    SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon
    FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[ids]);
  const nodeSet=new Set(nodes.filter(validCoord).map(n=>Number(n.id)));
  const usable=requests.filter(r=>nodeSet.has(Number(r.start_node_id))&&nodeSet.has(Number(r.end_node_id)));
  const {rows:vehiclesRaw}=await client.query(`
    SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,
      dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
      ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
      ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
    FROM public.veicolo v
    JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
    JOIN LATERAL (
      SELECT MIN(euro_km) AS euro_km FROM public.tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0
    ) t ON t.euro_km IS NOT NULL
    WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
      AND COALESCE(dv.coord,v.coord) IS NOT NULL
    ORDER BY t.euro_km,v.id`);
  const vehicles=vehiclesRaw.filter(v=>validCoord(v)&&Number(v.posti_totali)>0&&Number(v.euro_km)>0);
  const params={LIMIT,MAX_ROUTES,MAX_WAIT,BUFFER,MAX_CHAINS,MAX_FORMATIONS,
    MAX_DEPTH,MAX_GROUP,MAX_AGGREGATE,MAX_COMBOS,MAX_TOTAL,OPT_NODES,
    OPT_CANDIDATES,NEAR,WAIT_COST,INCLUDE_PAST};
  log('FLEET_REALE_INPUT',{parametri:params,richiesteLette:raw.length,
    richiesteUsabili:usable.length,nodi:nodes.length,veicoli:vehicles.length,
    richiestaIds:usable.map(r=>Number(r.id))});
  if(!usable.length||!vehicles.length){
    log('FLEET_REALE_VERDETTO',{esito:'NESSUN_DATO',motivo:'Nessuna richiesta o veicolo valido'});
  }else{
    const generated=await generaCandidatiFlotta({
      requests:usable,nodes:nodes.filter(validCoord),vehicles,road
      // Nessun validatore produttivo inventato: SOLO DIAGNOSTICA.
    },{
      now:new Date(state.now).getTime(),includePast:INCLUDE_PAST,
      maxWaitMin:MAX_WAIT,bufferMin:BUFFER,maxDepth:MAX_DEPTH,
      maxChains:MAX_CHAINS,maxFormations:MAX_FORMATIONS,
      maxGroupRequests:MAX_GROUP,maxAggregateCombos:MAX_AGGREGATE,
      maxCombosPerChainVehicle:MAX_COMBOS,maxTotalChainCombos:MAX_TOTAL,
      nearTransferMetres:NEAR,costoAttesaOra:WAIT_COST
    });
    const opt=ottimizzaFlotta(generated.candidati,{maxNodi:OPT_NODES,maxCandidati:OPT_CANDIDATES});
    log('FLEET_REALE_GENERAZIONE',generated.diagnostica);
    log('FLEET_REALE_OTTIMIZZAZIONE',{
      margine_euro:opt.margineTotaleEuro,cicli:opt.cicliSelezionati,
      richieste_coperte:opt.richiesteCoperte,richieste_ids:opt.richiesteIds,
      veicoli_usati:opt.veicoliUsati,nodi_esplorati:opt.nodiEsplorati,
      candidati_valutati:opt.candidatiValutati,candidati_tagliati:opt.candidatiTagliati,
      ottimo_sul_campione:opt.ottimoSulCampione,
      cicli_selezionati:selectedSummary(opt)
    });
    log('FLEET_REALE_ROUTING',{invocazioni_leg:routeCalls,cache_hit:cacheHits,
      errori_unici:routeErrors.size,limite_budget_raggiunto:budgetHits>0,
      errori:[...routeErrors.entries()].slice(0,10)});
    log('FLEET_REALE_VERDETTO',{
      esito:'SHADOW_COMPLETATO',read_only:true,attivazioni_eseguite:0,
      candidati_utilizzabili_per_attivazione:false,
      ottimo_sul_campione:opt.ottimoSulCampione,
      enumerazione_senza_tagli:generated.diagnostica.enumerazioneSenzaTagli,
      routing_senza_errori:generated.diagnostica.routingSenzaErrori&&budgetHits===0,
      confronto_10b:'DA_ESEGUIRE CON IDENTICO SNAPSHOT: questa esecuzione non confronta automaticamente il Test 10B',
      avvertenza:'Non certifica soglie di classe, pagamenti, qualità, turni, conflitti DB, raggio e transazione di attivazione. Il ritorno va incluso anche nella soglia di attivazione.'
    });
  }
}catch(e){
  console.error('[FLEET_REALE_ERRORE]',e.stack||e.message);
  process.exitCode=1;
}finally{
  if(client){
    if(started){try{await client.query('ROLLBACK');console.log('[FLEET_REALE_ROLLBACK] OK');}
      catch(e){console.error('[FLEET_REALE_ROLLBACK_ERRORE]',e.message);process.exitCode=1;}}
    client.release();
  }
  try{await pool.end();}catch(e){console.error('[FLEET_REALE_POOL_ERRORE]',e.message);process.exitCode=1;}
}
