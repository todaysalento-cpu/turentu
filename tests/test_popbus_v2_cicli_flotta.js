// TURENTU POPBUS V2 — COLLAUDO AGGREGAZIONE + CICLI + BASE VEICOLO
// Salva come tests/test_popbus_v2_cicli_flotta_db.js
// Esegui: node --env-file=.env tests\test_popbus_v2_cicli_flotta_db.js
// READ ONLY. Non avvia worker, pagamenti o socket. Google Maps puo' essere fatturato.
// DIAGNOSTICO: NON certifica attivabilita' (turni, conflitti, pagamenti, soglie e qualita').
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

const LIMIT = bounded('POPBUS_FLEET_REQUESTS', 40, 1, 120);
const MAX_GOOGLE = bounded('POPBUS_FLEET_ROUTES', 70, 1, 200);
const MAX_WAIT = bounded('POPBUS_FLEET_WAIT_MIN', 180, 0, 720);
const BUFFER = bounded('POPBUS_FLEET_BUFFER_MIN', 0, 0, 120);
const MAX_RESULTS = bounded('POPBUS_FLEET_RESULTS', 20, 1, 80);
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
async function main() {
  let client, transaction=false;
  console.log('\nTURENTU POPBUS V2 — TEST REALE AGGREGAZIONI, CICLI, FLOTTA | READ ONLY');
  console.log('Nessuna modifica schema/record. Nessun worker, pagamento o socket.');
  try {
    client=await pool.connect();
    await client.query('BEGIN READ ONLY');transaction=true;
    await client.query("SET LOCAL statement_timeout='20000ms'");
    const state=(await client.query("SELECT current_database() db,current_setting('transaction_read_only') read_only,now() now")).rows[0];
    if(state.read_only!=='on')throw new Error('READ ONLY non attivo');
    log('CONNESSIONE',state);
    const {rows:rawRequests}=await client.query(`
      SELECT r.* FROM public.richieste_pop_bus r
      WHERE r.stato='in_attesa' AND r.corsa_id IS NULL
        AND ($1::boolean OR r.start_datetime>NOW())
        AND NOT EXISTS (SELECT 1 FROM public.popbus_attivazione_richieste ar
                        WHERE ar.richiesta_id=r.id AND ar.attiva)
      ORDER BY r.start_datetime,r.id LIMIT $2`,[INCLUDE_PAST,LIMIT]);
    const requests=rawRequests.filter(r=>Number.isFinite(ms(r.start_datetime)) &&
      number(r.posti_richiesti)>0 && Number.isFinite(number(r.prezzo)) && number(r.prezzo)>=0);
    const nodeIds=[...new Set(requests.flatMap(r=>[number(r.start_node_id),number(r.end_node_id)]))];
    const {rows:rawNodes}=await client.query(`SELECT id,nome_nodo,
      ST_Y(posizione::geometry) lat,ST_X(posizione::geometry) lon
      FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[nodeIds]);
    const nodes=new Map(rawNodes.map(r=>[number(r.id),r]));
    const {rows:vehicles}=await client.query(`
      SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,dv.start,dv.fine,
        dv.manual,dv.giorni_esclusi,dv.inattivita,
        ST_Y(COALESCE(dv.coord,v.coord)::geometry) lat,
        ST_X(COALESCE(dv.coord,v.coord)::geometry) lon
      FROM public.veicolo v
      JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (SELECT MIN(euro_km) euro_km FROM public.tariffe
        WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t
        ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
        AND COALESCE(dv.coord,v.coord) IS NOT NULL
      ORDER BY t.euro_km,v.id`);
    log('CAMPIONE',{richieste:requests.length,gruppi_simultanei:groupByRouteAndTime(requests).length,
      veicoli:vehicles.length,include_passate:INCLUDE_PAST,google_max:MAX_GOOGLE,
      attesa_massima_min:MAX_WAIT,buffer_min:BUFFER});
    if(!requests.length || !vehicles.length){log('ESITO','Nessuna richiesta o veicolo per il test');return;}
    const maxSeats=Math.max(...vehicles.map(v=>number(v.posti_totali)));
    const missions=[];
    for(const group of groupByRouteAndTime(requests)) {
      const first=group[0];
      const start=nodes.get(number(first.start_node_id));
      const end=nodes.get(number(first.end_node_id));
      if(!validCoord(start)||!validCoord(end))continue;
      const trip=await road(start,end);
      if(!trip)continue;
      const depart=ms(first.start_datetime);
      const arrive=depart+trip.seconds*1000;
      for(const formation of aggregate(group,maxSeats)) {
        missions.push({...formation,start,end,trip,depart,arrive});
      }
    }
    const grouped=groupByRouteAndTime(requests);
    log('AGGREGAZIONI',{gruppi:grouped.map(g=>({ids:g.map(r=>number(r.id)),
      origine:number(g[0].start_node_id),destinazione:number(g[0].end_node_id),
      partenza:iso(g[0].start_datetime),posti_totali:g.reduce((s,r)=>s+number(r.posti_richiesti),0),
      ricavo_totale_euro:fmt(g.reduce((s,r)=>s+number(r.prezzo),0))})),
      formazioni_entro_capienza_massima:missions.length,
      esempi:missions.slice().sort((a,b)=>b.revenue-a.revenue).slice(0,MAX_RESULTS).map(brief)});

    // Sequenze tra gruppi temporali differenti: nessuna richiesta duplicata.
    // Scelta del gruppo aggregato per ogni veicolo in base alla sua capienza.
    const outcomes=[];
    const candidates=[];
    let evaluated=0, rejectedTime=0, missingRoutes=0;
    const byGroup=new Map();
    for(const m of missions) {
      const key=`${m.start.id}|${m.end.id}|${m.depart}`;
      if(!byGroup.has(key))byGroup.set(key,[]);
      byGroup.get(key).push(m);
    }
    const baseGroups=[...byGroup.values()].sort((a,b)=>a[0].depart-b[0].depart);
    for(let i=0;i<baseGroups.length;i++) {
      const A=baseGroups[i];
      for(let j=i+1;j<baseGroups.length;j++) {
        const B=baseGroups[j];
        if(B[0].depart<=A[0].depart)continue;
        if(B[0].depart-A[0].arrive>(MAX_WAIT+240)*60000)continue;
        evaluated++;
        const link=await road(A[0].end,B[0].start);
        if(!link){missingRoutes++;continue;}
        const slack=(B[0].depart-A[0].arrive-link.seconds*1000-BUFFER*60000)/60000;
        if(slack<0 || slack>MAX_WAIT){rejectedTime++;continue;}
        candidates.push({A,B,link,slack});
      }
    }
    log('COLLEGAMENTI_GRUPPI',{valutati:evaluated,compatibili:candidates.length,
      esclusi_orario:rejectedTime,routing_mancante:missingRoutes,
      esempi:candidates.slice(0,MAX_RESULTS).map(c=>({
        prima:c.A[0].ids,seconda:c.B[0].ids,trasferimento_km:fmt(c.link.metres/1000),
        trasferimento_min:fmt(c.link.seconds/60),margine_min:fmt(c.slack)}))});

    // Valutazione costi completa di avvicinamento e ritorno verso base del veicolo.
    // NESSUNA soglia economica e nessuna disponibilita' certificata.
    for(const c of candidates) {
      for(const v of vehicles) {
        const seats=number(v.posti_totali);
        const first=c.A.find(m=>m.seats<=seats);
        const second=c.B.find(m=>m.seats<=seats && !m.ids.some(id=>first?.ids.includes(id)));
        if(!first||!second)continue;
        const approach=await road(v,first.start);
        const back=await road(second.end,v);
        if(!approach||!back)continue;
        const metres=approach.metres+first.trip.metres+c.link.metres+second.trip.metres+back.metres;
        const revenue=first.revenue+second.revenue;
        const cost=metres/1000*number(v.euro_km);
        const ready=first.depart-approach.seconds*1000;
        const finish=second.arrive+back.seconds*1000;
        outcomes.push({veicolo:number(v.id),posti:seats,richieste:[first.ids,second.ids],
          partenza_da_base:iso(ready),ritorno_a_base:iso(finish),
          km_avvicinamento:fmt(approach.metres/1000),
          km_missioni:fmt((first.trip.metres+second.trip.metres)/1000),
          km_trasferimento:fmt(c.link.metres/1000),km_ritorno:fmt(back.metres/1000),
          km_totali:fmt(metres/1000),tariffa_euro_km:number(v.euro_km),
          ricavo_euro:fmt(revenue),costo_euro:fmt(cost),margine_lordo_euro:fmt(revenue-cost),
          rapporto_ricavo_costo:cost>0?fmt(revenue/cost):null,
          verifica_turno:'NON ESEGUITA',verifica_conflitti:'NON ESEGUITA',
          verifica_soglia_classe:'NON ESEGUITA'});
      }
    }
    outcomes.sort((a,b)=>b.margine_lordo_euro-a.margine_lordo_euro);
    log('CICLI_FLOTTA_PRELIMINARI',{totale:outcomes.length,esempi:outcomes.slice(0,MAX_RESULTS)});
    log('RIEPILOGO',{richieste:requests.length,missioni_aggregate:missions.length,
      collegamenti_compatibili:candidates.length,cicli_con_base_calcolata:outcomes.length,
      chiamate_google:calls,errori_routing:failures,limite_google_raggiunto:limitHits>0,
      tentativi_oltre_limite:limitHits,
      LIMITAZIONI:[
        'Solo coppie di missioni: triple e ritorni con passeggeri NON verificati',
        'Aggregazione solo per identici nodi e identico istante di partenza',
        'Non verifica turni, inattivita, conflitti, pagamenti, qualita passeggeri',
        'Non applica soglie economiche di classe; ritorno incluso nel costo preliminare',
        'Non verifica disponibilita del veicolo nel giorno della corsa',
        'I record storici eventualmente inclusi NON diventano attivabili',
        'Nessun record scritto o modificato'
      ]});
  } catch(e) {console.error('[ERRORE]',e.stack||e.message);process.exitCode=1;}
  finally {
    if(client){
      if(transaction) {
        try{await client.query('ROLLBACK');console.log('[TRANSAZIONE] ROLLBACK: nessun record modificato');}
        catch(e){console.error('[ERRORE ROLLBACK]',e.message);process.exitCode=1;}
      }
      client.release();
    }
    try{await pool.end();}catch(e){console.error('[ERRORE POOL]',e.message);process.exitCode=1;}
  }
}
await main();
