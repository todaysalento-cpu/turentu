// TURENTU POPBUS V2 — QUINTO TEST: MATCHING CICLICO 2-3 MISSIONI
// Salva come tests/test_popbus_v2_matching_ciclico.js
// Esegui: node --env-file=.env tests\test_popbus_v2_matching_ciclico.js
// READ ONLY. Non avvia worker, pagamenti o socket. Google Maps puo' essere fatturato.
// DIAGNOSTICO: NON certifica attivabilita' (turni, conflitti, pagamenti, soglie e qualita').
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

const LIMIT = bounded('POPBUS_FLEET_REQUESTS', 40, 1, 120);
const MAX_GOOGLE = bounded('POPBUS_FLEET_ROUTES', 100, 1, 300);
const MAX_WAIT = bounded('POPBUS_FLEET_WAIT_MIN', 180, 0, 720);
const BUFFER = bounded('POPBUS_FLEET_BUFFER_MIN', 0, 0, 120);
const MAX_RESULTS = bounded('POPBUS_FLEET_RESULTS', 20, 1, 80);
const MAX_CHAINS = bounded('POPBUS_CYCLE_MAX_CHAINS', 500, 10, 5000);
const MAX_FORMATIONS = bounded('POPBUS_CYCLE_FORMATIONS', 8, 1, 40);
const MAX_DEPTH = bounded('POPBUS_CYCLE_DEPTH', 3, 2, 3);
const INCLUDE_PAST = process.env.POPBUS_CYCLE_INCLUDE_PAST === '1';
const fmt = x => Math.round(Number(x) * 100) / 100;
const ms = x => new Date(x).getTime();
const iso = x => new Date(x).toISOString();
const log = (name, obj) => console.log(`[${name}] ${JSON.stringify(obj, null, 2)}`);
const number = x => Number(x);
function bounded(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}
function validCoord(p) {
  return p && Number.isFinite(number(p.lat)) && Number.isFinite(number(p.lon)) &&
    Math.abs(number(p.lat)) <= 90 && Math.abs(number(p.lon)) <= 180;
}
function equalCoord(a, b) {
  return Math.abs(number(a.lat)-number(b.lat)) < 1e-7 &&
    Math.abs(number(a.lon)-number(b.lon)) < 1e-7;
}
const cache = new Map();
let calls = 0, failures = 0, limitHits = 0;
async function road(a, b) {
  if (!validCoord(a) || !validCoord(b)) return null;
  if (equalCoord(a,b)) return {metres:0,seconds:0};
  const key = `${a.id ?? `${a.lat},${a.lon}`}>${b.id ?? `${b.lat},${b.lon}`}`;
  if (cache.has(key)) return cache.get(key);
  if (calls >= MAX_GOOGLE) {limitHits++; return null;}
  calls++;
  try {
    const l = await leg(a,b);
    if (!(number(l.metres)>0 && number(l.seconds)>0)) throw new Error('Percorso non valido');
    const value={metres:number(l.metres),seconds:number(l.seconds)};
    cache.set(key,value);
    return value;
  } catch (e) {
    failures++;
    log('ROUTING_ERROR',{percorso:key,messaggio:e.message});
    return null;
  }
}
function groupByRouteAndTime(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.start_node_id}|${r.end_node_id}|${ms(r.start_datetime)}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  return [...groups.values()];
}
// Enumerazione di sottoinsiemi di richieste simultanee, senza dividere una richiesta
// su piu' veicoli. Limiti espliciti per evitare esplosione combinatoria.
function aggregate(group, maxSeats) {
  const sorted=[...group].sort((a,b)=>number(b.prezzo)-number(a.prezzo));
  const combos=[];
  const capped=sorted.slice(0,12);
  function visit(i, picked, seats, revenue) {
    if (picked.length) combos.push({ids:picked.map(r=>number(r.id)).sort((a,b)=>a-b),
      seats,revenue,requests:[...picked]});
    if (i>=capped.length || combos.length>=2500) return;
    for(let j=i;j<capped.length;j++) {
      const seatsNext=seats+number(capped[j].posti_richiesti);
      if (seatsNext<=maxSeats) visit(j+1,[...picked,capped[j]],seatsNext,revenue+number(capped[j].prezzo));
      if(combos.length>=2500)break;
    }
  }
  visit(0,[],0,0);
  combos.sort((a,b)=>b.revenue-a.revenue || a.seats-b.seats);
  return combos;
}
function brief(m) {return {ids:m.ids,origine:m.start.id,destinazione:m.end.id,
  partenza:iso(m.depart),arrivo:iso(m.arrive),posti:m.seats,ricavo_euro:fmt(m.revenue),
  km:fmt(m.trip.metres/1000)};}

// Riproduzione diagnostica della logica di turno del worker, senza importarlo.
const clockFmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dayFmt = new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Rome',weekday:'short'});
const days=['sun','mon','tue','wed','thu','fri','sat'];
function minuteRome(t){const p=clockFmt.formatToParts(new Date(t));return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);}
function excludedDay(giorni,t){if(!Array.isArray(giorni)||!giorni.length)return false;
 const d=days.indexOf(dayFmt.format(new Date(t)).toLowerCase());
 const names=['domenica','lunedi','martedi','mercoledi','giovedi','venerdi','sabato'];
 return giorni.some(g=>{const v=String(g).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');return v===String(d)||(d===0&&v==='7')||v===names[d]||v===days[d];});}
function inactive(v,a,b){if(!Array.isArray(v.inattivita)||!v.inattivita.length)return false;
 return v.inattivita.some(p=>{if(!p||typeof p!=='object')return true;
 const s=p.start??p.inizio??p.dal??p.da,e=p.fine??p.end??p.al??p.a;
 if(!s||!e)return true;const x=ms(s),y=ms(e);return !Number.isFinite(x)||!Number.isFinite(y)||x<b&&y>a;});}
function shiftValid(v,a,b){if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||!v.start||!v.fine)return false;
 const s=minuteRome(v.start),e=minuteRome(v.fine);
 if(!Number.isFinite(s)||!Number.isFinite(e)||s===e||inactive(v,a,b))return false;
 for(let t=a;t<b;t=Math.min(b,Math.floor(t/60000)*60000+60000)){
  const m=minuteRome(t),valid=s<e?(m>=s&&m<e):(m>=s||m<e);
  if(!valid)return false;
  const shiftDay=s>e&&m<e?t-86400000:t;
  if(excludedDay(v.giorni_esclusi,shiftDay))return false;
 }
 return true;
}
async function findConflicts(client,vehicleId,a,b){
 const {rows}=await client.query(`
 SELECT 'attivazione' AS origine,a.id::text AS id
 FROM public.popbus_attivazioni a
 WHERE a.veicolo_id=$1 AND a.stato IN ('in_attesa_autista','confermata')
 AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza)<$3::timestamptz
 AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo)>$2::timestamptz
 UNION ALL
 SELECT 'corsa',c.id::text
 FROM public.corse c
 WHERE c.veicolo_id=$1 AND c.stato IN ('prenotabile','in_corso','da_attivare')
 AND c.start_datetime<$3::timestamptz
 AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime>$2::timestamptz)
 AND NOT EXISTS(SELECT 1 FROM public.popbus_attivazioni a WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id AND a.stato IN ('in_attesa_autista','confermata'))
 UNION ALL
 SELECT 'direttrice',d.id::text
 FROM public.direttrici_virtuali d JOIN public.segmenti s ON s.direttrice_id=d.id
 WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata')
 AND d.partenza_prevista<$3::timestamptz
 AND NOT EXISTS(SELECT 1 FROM public.popbus_attivazioni a WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id AND a.stato IN ('in_attesa_autista','confermata'))
 GROUP BY d.id,d.partenza_prevista
 HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute')>$2::timestamptz
 `,[vehicleId,new Date(a),new Date(b)]);
 return rows;
}

async function main(){
 let client,tx=false;
 console.log('TURENTU POPBUS V2 — QUINTO TEST MATCHING CICLICO | READ ONLY');
 console.log('Nessuna scrittura, nessun worker, nessuna verifica pagamento, nessun socket. Routing Google potenzialmente fatturato.');
 try{
  client=await pool.connect(); await client.query('BEGIN READ ONLY');tx=true;
  await client.query("SET LOCAL statement_timeout='20000ms'");
  const state=(await client.query("SELECT current_database() db,current_setting('transaction_read_only') read_only,now() now")).rows[0];
  if(state.read_only!=='on')throw Error('Transazione non read-only');
  log('CONNESSIONE',state);
  const {rows:raw}=await client.query(`SELECT r.* FROM public.richieste_pop_bus r
   WHERE r.stato='in_attesa' AND r.corsa_id IS NULL AND ($1::boolean OR r.start_datetime>NOW())
   AND NOT EXISTS(SELECT 1 FROM public.popbus_attivazione_richieste ar WHERE ar.richiesta_id=r.id AND ar.attiva)
   ORDER BY r.start_datetime,r.id LIMIT $2`,[INCLUDE_PAST,LIMIT]);
  const requests=raw.filter(r=>Number.isFinite(ms(r.start_datetime)) && number(r.posti_richiesti)>0 && Number.isFinite(number(r.prezzo)) && number(r.prezzo)>=0);
  const ids=[...new Set(requests.flatMap(r=>[number(r.start_node_id),number(r.end_node_id)]))];
  const {rows:rawNodes}=await client.query(`SELECT id,nome_nodo,ST_Y(posizione::geometry) lat,ST_X(posizione::geometry) lon FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[ids]);
  const nodes=new Map(rawNodes.map(n=>[number(n.id),n]));
  const {rows:vehicles}=await client.query(`SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
   ST_Y(COALESCE(dv.coord,v.coord)::geometry) lat,ST_X(COALESCE(dv.coord,v.coord)::geometry) lon
   FROM public.veicolo v JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
   JOIN LATERAL(SELECT MIN(euro_km) euro_km FROM public.tariffe WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0)t ON t.euro_km IS NOT NULL
   WHERE v.driver_id IS NOT NULL AND v.posti_totali>0 AND COALESCE(dv.coord,v.coord) IS NOT NULL ORDER BY t.euro_km,v.id`);
  log('PARAMETRI',{richieste:requests.length,veicoli:vehicles.length,include_passate:INCLUDE_PAST,max_wait_min:MAX_WAIT,buffer_min:BUFFER,max_depth:MAX_DEPTH,max_chains:MAX_CHAINS,max_google:MAX_GOOGLE});
  if(!requests.length||!vehicles.length)return;
  const maxSeats=Math.max(...vehicles.map(v=>number(v.posti_totali)));
  const missions=[];
  for(const group of groupByRouteAndTime(requests)){
   const first=group[0],start=nodes.get(number(first.start_node_id)),end=nodes.get(number(first.end_node_id));
   if(!validCoord(start)||!validCoord(end))continue;
   const trip=await road(start,end);if(!trip)continue;
   for(const f of aggregate(group,maxSeats).slice(0,MAX_FORMATIONS))missions.push({...f,start,end,trip,depart:ms(first.start_datetime),arrive:ms(first.start_datetime)+trip.seconds*1000});
  }
  // I collegamenti vengono calcolati tra gruppi, non fra tutte le combinazioni di formazione.
  const groupMap=new Map();for(const m of missions){const k=`${m.start.id}|${m.end.id}|${m.depart}`;if(!groupMap.has(k))groupMap.set(k,[]);groupMap.get(k).push(m);}
  const groups=[...groupMap.values()].sort((a,b)=>a[0].depart-b[0].depart);
  const edges=new Map();let checked=0,valid=0,timeReject=0,routeReject=0;
  for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
   const a=groups[i][0],b=groups[j][0];if(b.depart<=a.depart)continue;
   if(b.depart-a.arrive>(MAX_WAIT+BUFFER+240)*60000)continue;
   checked++;const transfer=await road(a.end,b.start);if(!transfer){routeReject++;continue;}
   const wait=b.depart-a.arrive-transfer.seconds*1000-BUFFER*60000;
   if(wait<0||wait>MAX_WAIT*60000){timeReject++;continue;}
   if(!edges.has(i))edges.set(i,[]);edges.get(i).push({to:j,transfer,wait});valid++;
  }
  log('MISSIONI_E_COLLEGAMENTI',{missioni:missions.length,gruppi:groups.length,collegamenti_esaminati:checked,collegamenti_validi:valid,scarti_temporali:timeReject,routing_mancante:routeReject});
  // Enumerazione di catene 2-3 missioni. Non filtra mai la redditivita' della singola missione.
  const chains=[];
  function visit(path,links){if(chains.length>=MAX_CHAINS)return;
   if(path.length>=2)chains.push({path:[...path],links:[...links]});
   if(path.length>=MAX_DEPTH)return;
   for(const e of edges.get(path.at(-1))||[]){if(chains.length>=MAX_CHAINS)break;visit([...path,e.to],[...links,e]);}
  }
  for(let i=0;i<groups.length&&chains.length<MAX_CHAINS;i++)visit([i],[]);
  log('CATENE_GENERATE',{totale:chains.length,due:chains.filter(c=>c.path.length===2).length,tre:chains.filter(c=>c.path.length===3).length,limite_raggiunto:chains.length>=MAX_CHAINS});
  const results=[];const counters={combinazioni_valutate:0,capienza_o_duplicati:0,routing_incompleto:0,turno_non_compatibile:0,conflitti:0,passate:0,economicamente_negative:0,economicamente_positive:0,conflitti_non_verificabili:0};
  const now=Date.now();
  for(const chain of chains){
   for(const v of vehicles){
    const seats=number(v.posti_totali),rate=number(v.euro_km);
    // Valuta diverse formazioni, non soltanto quella con ricavo piu' alto.
    let combos=[{selected:[],used:new Set(),revenue:0}];
    for(const gi of chain.path){const next=[];
     for(const x of combos)for(const m of groups[gi]){
      if(m.seats>seats||m.ids.some(id=>x.used.has(id)))continue;
      next.push({selected:[...x.selected,m],used:new Set([...x.used,...m.ids]),revenue:x.revenue+m.revenue});
     }
     next.sort((a,b)=>b.revenue-a.revenue);
     combos=next.slice(0,MAX_FORMATIONS);
     if(!combos.length)break;
    }
    if(!combos.length){counters.capienza_o_duplicati++;continue;}
    const first=groups[chain.path[0]][0],last=groups[chain.path.at(-1)][0];
    const approach=await road(v,first.start),back=await road(last.end,v);
    if(!approach||!back){counters.routing_incompleto++;continue;}
    const start=first.depart-approach.seconds*1000,end=last.arrive+back.seconds*1000;
    const historical=start<=now;
    const turnOK=shiftValid(v,start,end);
    let conflicts=[],conflictError=null;
    try{conflicts=await findConflicts(client,number(v.id),start,end);}catch(e){conflictError=e.message;counters.conflitti_non_verificabili++;}
    const baseMetres=approach.metres+back.metres+chain.links.reduce((s,l)=>s+l.transfer.metres,0);
    for(const x of combos){
     counters.combinazioni_valutate++;
     const commercial=x.selected.reduce((s,m)=>s+m.trip.metres,0);
     const total=baseMetres+commercial;
     const cost=Math.ceil(total/1000*rate*100)/100;
     const margin=fmt(x.revenue-cost);
     const economical=x.revenue>=cost;
     if(economical)counters.economicamente_positive++;else counters.economicamente_negative++;
     if(historical)counters.passate++;
     if(!turnOK)counters.turno_non_compatibile++;
     if(conflicts.length)counters.conflitti++;
     const reasons=[];
     if(historical)reasons.push('PARTENZA_TRASCORSA');
     if(!turnOK)reasons.push('TURNO_O_INATTIVITA');
     if(conflicts.length)reasons.push('CONFLITTO_VEICOLO');
     if(!economical)reasons.push('RICAVO_INFERIORE_COSTO_COMPLETO');
     if(conflictError)reasons.push('CONFLITTI_NON_VERIFICABILI');
     const selectedIds=x.selected.flatMap(m=>m.ids);
     const classes=[...new Set(x.selected.flatMap(m=>m.requests.map(r=>r.classe)))];
     results.push({veicolo:number(v.id),posti:seats,richieste:x.selected.map(m=>m.ids),classi:classes,
      missioni:x.selected.length,partenza_base:iso(start),ritorno_base:iso(end),
      attesa_minuti:chain.links.map(l=>fmt(l.wait/60000)),
      km_avvicinamento:fmt(approach.metres/1000),km_commerciali:fmt(commercial/1000),
      km_trasferimenti:fmt(chain.links.reduce((s,l)=>s+l.transfer.metres,0)/1000),km_ritorno:fmt(back.metres/1000),km_totali:fmt(total/1000),
      ricavo_euro:fmt(x.revenue),costo_completo_euro:cost,margine_euro:margin,
      turni_ok:turnOK,conflitti:conflicts.slice(0,5),conflitti_errore:conflictError,
      copertura_integrale:economical,esito:reasons.length?'SCARTATO_O_NON_CERTIFICABILE':'PRELIMINARE_NON_CERTIFICATO',motivi:reasons,
      controlli_non_eseguiti:['pagamenti','qualita_individuale_e_occorrerenze','soglie_di_classe','rivalidazione_transazionale'],
      confronto_singole:'NON CALCOLATO: servirebbero routing base-missione-base per ogni missione'});
    }
   }
  }
  results.sort((a,b)=>b.margine_euro-a.margine_euro);
  const viable=results.filter(r=>r.copertura_integrale&&r.turni_ok&&!r.conflitti.length&&!r.conflitti_errore);
  const future=viable.filter(r=>ms(r.partenza_base)>now);
  log('MIGLIORI_CICLI_ECONOMICI', {totale:results.length,esempi:results.filter(r=>r.copertura_integrale).slice(0,MAX_RESULTS)});
  log('CICLI_OPERATIVAMENTE_COMPATIBILI_PRELIMINARI',{totale:viable.length,futuri:future.length,esempi:viable.slice(0,MAX_RESULTS)});
  log('SCARTI_E_STATISTICHE',counters);
  log('RIEPILOGO_QUINTO_TEST',{richieste:requests.length,veicoli:vehicles.length,missioni:missions.length,catene:chains.length,
   combinazioni:results.length,con_copertura_integrale:results.filter(r=>r.copertura_integrale).length,
   compatibili_operativamente_preliminari:viable.length,compatibili_future_preliminari:future.length,
   google_chiamate:calls,google_errori:failures,google_limite_raggiunto:limitHits>0,google_richieste_oltre_limite:limitHits,
   avvertenze:[
    'Non certifica attivabilita: pagamenti, qualita individuale, soglie di classe e rivalidazione non verificati',
    'Le richieste storiche non sono attivabili oggi; nessuno spostamento fittizio di date',
    'La convenienza individuale NON e filtro: la redditivita e valutata sul ciclo completo, incluso il ritorno',
    'Aggregazione limitata a stessa origine/destinazione e stessa partenza; non e il generatore completo del model di produzione',
    'Capienza controllata per missione non sovrapposta; nessuna sovrapposizione passeggeri tra missioni',
    'Attesa fra missioni inclusa nella verifica del turno, ma non monetizzata nel costo a km',
    'Classi miste e nodi ripetuti non sono certificati dal percorso transazionale attuale',
    'Raggio operativo non verificato: la semantica del campo va confermata',
    'Nessuna modifica a database, worker, frontend, pagamenti o socket'
   ]});
 }catch(e){console.error('[ERRORE]',e.stack||e.message);process.exitCode=1;}
 finally{if(client){if(tx){try{await client.query('ROLLBACK');console.log('[TRANSAZIONE] ROLLBACK: nessun record modificato');}catch(e){console.error('[ERRORE ROLLBACK]',e.message);process.exitCode=1;}}client.release();}
  try{await pool.end();}catch(e){console.error('[ERRORE POOL]',e.message);process.exitCode=1;}}
}
await main();
