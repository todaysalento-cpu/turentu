// TURENTU POPBUS V2 — COLLAUDO CICLI REALI M1 -> M2 -> M3
// Salva in: tests/test_popbus_v2_cicli_db.js
// CMD: node --env-file=.env tests\test_popbus_v2_cicli_db.js
// SOLO LETTURA: transazione PostgreSQL READ ONLY + ROLLBACK.
// NON importa il worker, NON invia socket, NON effettua pagamenti.
// Google Maps può consumare quote fatturabili.
// IMPORTANTE: diagnostica di sequenze di richieste singole, NON validazione
// completa di attivazioni, qualità commerciale, pagamenti o disponibilità.

import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

const MAX_REQUESTS = Math.max(1, Math.min(100, Number(process.env.POPBUS_CYCLE_REQUESTS || 35)));
const MAX_PAIRS = Math.max(1, Math.min(300, Number(process.env.POPBUS_CYCLE_PAIRS || 80)));
const MAX_TRIPLES = Math.max(1, Math.min(100, Number(process.env.POPBUS_CYCLE_TRIPLES || 20)));
const MAX_ROUTES = Math.max(1, Math.min(120, Number(process.env.POPBUS_CYCLE_ROUTES || 35)));
const MAX_WAIT_MIN = Math.max(0, Math.min(720, Number(process.env.POPBUS_CYCLE_WAIT_MIN || 180)));
const ALLOW_PAST = process.env.POPBUS_CYCLE_INCLUDE_PAST === '1';
const TOLERANCE_MIN = Math.max(0, Math.min(120, Number(process.env.POPBUS_CYCLE_TOLERANCE_MIN || 0)));
const MIN_BUFFER_MIN = Math.max(0, Math.min(120, Number(process.env.POPBUS_CYCLE_BUFFER_MIN || 0)));
const fmt = n => Math.round(Number(n) * 100) / 100;
const iso = t => new Date(t).toISOString();
const log = (name, data) => console.log(`[${name}] ${JSON.stringify(data, null, 2)}`);
const n = x => Number(x);
const time = x => new Date(x).getTime();
const routes = new Map();
let routeCalls = 0;
let routeErrors = 0;

function validNode(x) {
  return x && Number.isFinite(n(x.lat)) && Number.isFinite(n(x.lon)) &&
    Math.abs(n(x.lat)) <= 90 && Math.abs(n(x.lon)) <= 180;
}
function same(a,b) {
  return Math.abs(n(a.lat)-n(b.lat)) < 1e-7 && Math.abs(n(a.lon)-n(b.lon)) < 1e-7;
}
async function road(a,b) {
  if (!validNode(a) || !validNode(b)) throw new Error('Coordinate mancanti o non valide');
  if (same(a,b)) return {metres:0, seconds:0};
  const key = `${a.id ?? `${a.lat},${a.lon}`}>${b.id ?? `${b.lat},${b.lon}`}`;
  if (routes.has(key)) return routes.get(key);
  if (routeCalls >= MAX_ROUTES) return null;
  routeCalls++;
  try {
    const result = await leg(a,b);
    if (!(n(result.metres)>0 && n(result.seconds)>0)) throw new Error('Risposta routing non valida');
    const value = {metres:n(result.metres),seconds:n(result.seconds)};
    routes.set(key,value);
    return value;
  } catch(e) { routeErrors++; console.log(`[ROUTING ERROR] ${key}: ${e.message}`); return null; }
}
function entry(r, nodes) { return nodes.get(n(r.start_node_id)); }
function exit(r, nodes) { return nodes.get(n(r.end_node_id)); }
function summary(r) { return {id:r.id,origine:r.start_node_id,destinazione:r.end_node_id,partenza:iso(r.start_datetime),posti:n(r.posti_richiesti),ricavo_euro:fmt(r.prezzo)}; }

async function main() {
  let client, started = false;
  const errors=[];
  console.log('\nTURENTU POPBUS V2 — CICLI REALI SU DATABASE | READ ONLY');
  console.log('Nessuna modifica a schema o record. Nessun worker avviato.');
  try {
    client=await pool.connect();
    await client.query('BEGIN READ ONLY'); started=true;
    await client.query("SET LOCAL statement_timeout='20000ms'");
    const state=(await client.query("SELECT current_database() AS db,current_setting('transaction_read_only') AS read_only,now() AS now")).rows[0];
    if(state.read_only!=='on') throw new Error('Transazione non READ ONLY');
    log('CONNESSIONE',state);

    // Campione ordinato temporalmente, senza record attivati e senza duplicazioni.
    const {rows:requests}=await client.query(`
      SELECT r.* FROM public.richieste_pop_bus r
      WHERE r.stato='in_attesa' AND r.corsa_id IS NULL
        AND ($1::boolean OR r.start_datetime > NOW())
        AND NOT EXISTS (SELECT 1 FROM public.popbus_attivazione_richieste ar
                        WHERE ar.richiesta_id=r.id AND ar.attiva)
      ORDER BY r.start_datetime,r.id LIMIT $2`,[ALLOW_PAST,MAX_REQUESTS]);
    const req=requests.filter(r=>Number.isFinite(time(r.start_datetime)) &&
      n(r.posti_richiesti)>0 && Number.isFinite(n(r.prezzo)) && n(r.prezzo)>=0);
    const ids=[...new Set(req.flatMap(r=>[n(r.start_node_id),n(r.end_node_id)]))];
    const {rows:rawNodes}=await client.query(`SELECT id,nome_nodo,
      ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon
      FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[ids]);
    const nodes=new Map(rawNodes.map(r=>[n(r.id),r]));
    log('CAMPIONE',{richieste:req.length,nodi:nodes.size,include_passate:ALLOW_PAST,
      max_wait_min:MAX_WAIT_MIN,tolleranza_min:TOLERANCE_MIN,buffer_min:MIN_BUFFER_MIN,
      limite_chiamate_google:MAX_ROUTES});
    if(!req.length){log('ESITO','Nessuna richiesta disponibile. Nessun routing eseguito.');return;}
    const missing=ids.filter(id=>!validNode(nodes.get(id)));
    if(missing.length)log('NODI_MANCANTI',missing);

    // Ogni missione è la tratta diretta della richiesta. I gruppi aggregati
    // vengono valutati in una fase successiva: qui NON si sommano ricavi
    // di richieste che viaggiano contemporaneamente.
    const missions=[];
    for(const r of req) {
      if(!validNode(entry(r,nodes))||!validNode(exit(r,nodes)))continue;
      const trip=await road(entry(r,nodes),exit(r,nodes));
      if(!trip)continue;
      const depart=time(r.start_datetime);
      missions.push({r,trip,depart,arrive:depart+trip.seconds*1000});
    }
    log('MISSIONI_ROUTATE',{totale:missions.length,esempi:missions.slice(0,12).map(m=>({
      ...summary(m.r),km:fmt(m.trip.metres/1000),durata_min:fmt(m.trip.seconds/60),arrivo:iso(m.arrive)
    }))});

    // Le coppie sono cronologiche, con eventuale trasferimento a vuoto.
    // Il trasferimento NON è una corsa commerciale, a meno di un matching
    // successivo di una richiesta effettiva.
    const pairs=[];
    let evaluated=0, rejectedTime=0, unknown=0;
    for(const a of missions) {
      if(evaluated>=MAX_PAIRS)break;
      for(const b of missions) {
        if(evaluated>=MAX_PAIRS)break;
        if(n(a.r.id)===n(b.r.id)||b.depart<=a.depart)continue;
        const gapMs=b.depart-a.arrive;
        if(gapMs > (MAX_WAIT_MIN+240)*60000)continue;
        evaluated++;
        const link=await road(exit(a.r,nodes),entry(b.r,nodes));
        if(!link){unknown++;continue;}
        const ready=a.arrive+link.seconds*1000+MIN_BUFFER_MIN*60000;
        const slack=(b.depart-ready)/60000;
        if(slack < -TOLERANCE_MIN || slack>MAX_WAIT_MIN){rejectedTime++;continue;}
        pairs.push({a,b,link,slack});
      }
    }
    pairs.sort((x,y)=>x.a.depart-y.a.depart || x.b.depart-y.b.depart || n(x.a.r.id)-n(y.a.r.id));
    log('COPPIE_COMPATIBILI',{trovate:pairs.length,coppie_valutate:evaluated,
      escluse_per_orario:rejectedTime,routing_non_disponibile:unknown,
      esempi:pairs.slice(0,20).map(p=>({prima:n(p.a.r.id),seconda:n(p.b.r.id),
        arrivo_prima:iso(p.a.arrive),partenza_seconda:iso(p.b.depart),
        trasferimento_km:fmt(p.link.metres/1000),trasferimento_min:fmt(p.link.seconds/60),
        attesa_min:fmt(p.slack)}))});

    // Triple solo se entrambe le connessioni sono già state verificate.
    const triples=[];
    for(const ab of pairs) {
      for(const bc of pairs) {
        if(triples.length>=MAX_TRIPLES)break;
        if(n(ab.b.r.id)!==n(bc.a.r.id)||n(ab.a.r.id)===n(bc.b.r.id))continue;
        triples.push({ab,bc});
      }
      if(triples.length>=MAX_TRIPLES)break;
    }
    log('TRIPLE_COMPATIBILI',{totale:triples.length,limite:MAX_TRIPLES,
      esempi:triples.map(({ab,bc})=>({ids:[n(ab.a.r.id),n(ab.b.r.id),n(bc.b.r.id)],
        km_missioni:fmt((ab.a.trip.metres+ab.b.trip.metres+bc.b.trip.metres)/1000),
        km_collegamenti:fmt((ab.link.metres+bc.link.metres)/1000),
        ricavo_euro:fmt(n(ab.a.r.prezzo)+n(ab.b.r.prezzo)+n(bc.b.r.prezzo)),
        arrivo_finale:iso(bc.b.arrive)}))});

    // Costo preliminare: include le missioni, i trasferimenti e un ritorno
    // all'origine della prima missione (NON alla base effettiva del veicolo).
    // Non applica soglie di classe e NON autorizza attivazioni.
    const economic=[];
    for(const p of pairs.slice(0,8)) {
      const back=await road(exit(p.b.r,nodes),entry(p.a.r,nodes));
      if(!back)continue;
      const total=p.a.trip.metres+p.link.metres+p.b.trip.metres+back.metres;
      economic.push({ids:[n(p.a.r.id),n(p.b.r.id)],
        km_missioni:fmt((p.a.trip.metres+p.b.trip.metres)/1000),
        km_trasferimento:fmt(p.link.metres/1000),km_ritorno_finale:fmt(back.metres/1000),
        km_totali:fmt(total/1000),ricavo_euro:fmt(n(p.a.r.prezzo)+n(p.b.r.prezzo)),
        nota:'Ritorno alla prima origine: costo provvisorio, NON base reale del veicolo'});
    }
    log('COSTI_PRELIMINARI_COPPIE',economic);
    log('RIEPILOGO',{missioni:missions.length,coppie:pairs.length,triple:triples.length,
      chiamate_google:routeCalls,errori_routing:routeErrors,limite_google:MAX_ROUTES,
      avvertenze:[
        'Campione limitato: zero coppie non prova assenza di cicli nell’intero DB',
        'Nessuna verifica turni, conflitti, pagamento, qualità passeggero o soglia classe',
        'Ritorno calcolato alla prima origine, non alla base reale del veicolo',
        'Richieste simultanee non aggregate in questo test',
        'Le richieste già trascorse sono escluse salvo POPBUS_CYCLE_INCLUDE_PAST=1'
      ]});
  } catch(e){errors.push(e.message);console.error('[ERRORE]',e.stack||e.message);process.exitCode=1;}
  finally {
    if(client){
      if(started){try{await client.query('ROLLBACK');console.log('[TRANSAZIONE] ROLLBACK: nessun record modificato');}
        catch(e){errors.push('ROLLBACK: '+e.message);process.exitCode=1;}}
      client.release();
    }
    try{await pool.end();}catch(e){errors.push('POOL: '+e.message);process.exitCode=1;}
    log('ERRORI',errors);
  }
}
await main();
