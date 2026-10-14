// TURENTU POPBUS V2 — DIAGNOSTICA MIRATA 27/28/29, VEICOLI 362/366
// READ ONLY: nessuna scrittura DB, nessun worker, nessun pagamento.
// ATTENZIONE: usa services/popbus/v2/planner.js -> leg(): Google Maps puo' essere fatturato.
// Salva questo file come tests/test_popbus_routing_27_28_29.js
// Avvia da project-root: node --env-file=.env tests\test_popbus_routing_27_28_29.js > risultato_routing_27_28_29.txt 2>&1
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

const REQUEST_IDS = [27, 28, 29];
const VEHICLE_IDS = [362, 366];
const MAX_ROUTES = 8; // 1 commerciale + max 2 avvicinamenti + max 2 rientri; limite di sicurezza
const cache = new Map();
let routes = 0;
const num = x => Number(x);
const money = x => Math.round((x + Number.EPSILON) * 100) / 100;
const iso = x => new Date(x).toISOString();
const log = (name, data) => console.log(`\n[${name}] ${JSON.stringify(data, null, 2)}`);
const validCoord = p => p && Number.isFinite(num(p.lat)) && Number.isFinite(num(p.lon)) && Math.abs(num(p.lat)) <= 90 && Math.abs(num(p.lon)) <= 180;
const clockFmt = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Rome', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const dayFmt = new Intl.DateTimeFormat('en-US', {timeZone:'Europe/Rome', weekday:'short'});
const days = ['sun','mon','tue','wed','thu','fri','sat'];
function minuteRome(t) {
  const p = clockFmt.formatToParts(new Date(t));
  return Number(p.find(x => x.type === 'hour').value)*60 + Number(p.find(x => x.type === 'minute').value);
}
function excludedDay(giorni, t) {
  if (!Array.isArray(giorni) || !giorni.length) return false;
  const d = days.indexOf(dayFmt.format(new Date(t)).toLowerCase());
  const names = ['domenica','lunedi','martedi','mercoledi','giovedi','venerdi','sabato'];
  return giorni.some(g => {
    const v = String(g).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return v === String(d) || (d === 0 && v === '7') || v === names[d] || v === days[d];
  });
}
function inactive(v,a,b) {
  if (!Array.isArray(v.inattivita) || !v.inattivita.length) return false;
  return v.inattivita.some(p => {
    if (!p || typeof p !== 'object') return true;
    const s = p.start ?? p.inizio ?? p.dal ?? p.da;
    const e = p.fine ?? p.end ?? p.al ?? p.a;
    if (!s || !e) return true;
    const x = Date.parse(s), y = Date.parse(e);
    return !Number.isFinite(x) || !Number.isFinite(y) || (x < b && y > a);
  });
}
// Replica la semantica ORARIA del test flotta, NON certifica la validita' assoluta dell'intervallo start/fine.
function shiftValid(v,a,b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || !v.start || !v.fine) return false;
  const s = minuteRome(v.start), e = minuteRome(v.fine);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e || inactive(v,a,b)) return false;
  for (let t=a; t<b; t=Math.min(b,Math.floor(t/60000)*60000+60000)) {
    const m=minuteRome(t), valid=s<e ? (m>=s && m<e) : (m>=s || m<e);
    if (!valid) return false;
    const shiftDay=s>e && m<e ? t-86400000 : t;
    if (excludedDay(v.giorni_esclusi,shiftDay)) return false;
  }
  return true;
}
async function road(a,b) {
  if (!validCoord(a) || !validCoord(b)) throw new Error('Coordinate mancanti o non valide');
  if (num(a.lat) === num(b.lat) && num(a.lon) === num(b.lon)) return {metres:0,seconds:0};
  // Identificatori qualificati per evitare collisioni fra nodo e veicolo.
  const key=`${a.kind}:${a.id}>${b.kind}:${b.id}`;
  if (cache.has(key)) return cache.get(key);
  if (routes >= MAX_ROUTES) throw new Error(`Limite di sicurezza routing ${MAX_ROUTES} raggiunto`);
  routes++;
  try {
    const r = await leg(a,b);
    if (!(num(r.metres)>0 && num(r.seconds)>0)) throw new Error('Routing incompleto o non valido');
    const result={metres:num(r.metres),seconds:num(r.seconds)};
    cache.set(key,result);
    return result;
  } catch (e) {
    log('ROUTING_ERROR',{percorso:key,messaggio:e.message});
    throw e;
  }
}
async function conflicts(client,vehicleId,start,end) {
  // Stessi tre controlli di conflitto del test flotta; query read-only.
  const {rows}=await client.query(`
    SELECT 'attivazione' AS origine,a.id::text AS id
    FROM public.popbus_attivazioni a
    WHERE a.veicolo_id=$1 AND a.stato IN ('in_attesa_autista','confermata')
      AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza)<$3::timestamptz
      AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo)>$2::timestamptz
    UNION ALL
    SELECT 'corsa',c.id::text FROM public.corse c
    WHERE c.veicolo_id=$1 AND c.stato IN ('prenotabile','in_corso','da_attivare')
      AND c.start_datetime<$3::timestamptz
      AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime>$2::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM public.popbus_attivazioni a
        WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id AND a.stato IN ('in_attesa_autista','confermata'))
    UNION ALL
    SELECT 'direttrice',d.id::text FROM public.direttrici_virtuali d
    JOIN public.segmenti s ON s.direttrice_id=d.id
    WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata')
      AND d.partenza_prevista<$3::timestamptz
      AND NOT EXISTS (SELECT 1 FROM public.popbus_attivazioni a
        WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id AND a.stato IN ('in_attesa_autista','confermata'))
    GROUP BY d.id,d.partenza_prevista
    HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute')>$2::timestamptz
  `,[vehicleId,new Date(start),new Date(end)]);
  return rows;
}
function aggregate(requests, maxSeats) {
  const sorted=[...requests].sort((a,b)=>num(b.prezzo)-num(a.prezzo));
  const combos=[];
  function visit(i,picked,seats,revenue) {
    if (picked.length) combos.push({ids:picked.map(r=>num(r.id)).sort((a,b)=>a-b),seats,revenue});
    for(let j=i;j<sorted.length;j++) {
      const s=seats+num(sorted[j].posti_richiesti);
      if(s<=maxSeats)visit(j+1,[...picked,sorted[j]],s,revenue+num(sorted[j].prezzo));
    }
  }
  visit(0,[],0,0);
  return combos.sort((a,b)=>b.revenue-a.revenue||a.seats-b.seats);
}
async function main() {
  let client;
  try {
    client=await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='20000ms'");
    const check=(await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    if(check!=='on')throw new Error('Transazione non in sola lettura');
    const {rows:req}=await client.query(`SELECT id,cliente_id,start_node_id,end_node_id,start_datetime,posti_richiesti,prezzo,classe,stato,corsa_id
      FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[REQUEST_IDS]);
    if(req.length!==3 || req.some(r=>r.stato!=='in_attesa'||r.corsa_id!==null))throw new Error('Richieste mancanti o non piu in attesa');
    const groupKey=r=>`${r.start_node_id}|${r.end_node_id}|${new Date(r.start_datetime).getTime()}`;
    if(new Set(req.map(groupKey)).size!==1)throw new Error('Le richieste non condividono percorso e orario');
    const {rows:active}=await client.query(`SELECT richiesta_id FROM public.popbus_attivazione_richieste WHERE richiesta_id=ANY($1::int[]) AND attiva`,[REQUEST_IDS]);
    if(active.length)throw new Error('Almeno una richiesta e gia associata a una attivazione attiva');
    const {rows:nodes}=await client.query(`SELECT id,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon
      FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[[num(req[0].start_node_id),num(req[0].end_node_id)]]);
    const nodeMap=new Map(nodes.map(n=>[num(n.id),{...n,kind:'nodo'}]));
    const origin=nodeMap.get(num(req[0].start_node_id)),dest=nodeMap.get(num(req[0].end_node_id));
    if(!validCoord(origin)||!validCoord(dest))throw new Error('Nodi o coordinate non validi');
    const {rows:vehicles}=await client.query(`SELECT v.id,v.modello,v.posti_totali,t.euro_km,dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
      ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM public.veicolo v JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM public.tariffe WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
      WHERE v.id=ANY($1::int[]) AND v.driver_id IS NOT NULL AND COALESCE(dv.coord,v.coord) IS NOT NULL ORDER BY v.id`,[VEHICLE_IDS]);
    log('PARAMETRI',{richieste:REQUEST_IDS,veicoli:VEHICLE_IDS,max_chiamate_routing:MAX_ROUTES,read_only:true,nota:'Il routing puo essere fatturato; le soglie EXPRESS e commissioni non vengono validate'});
    log('RICHIESTE',req);
    log('VEICOLI',vehicles.map(v=>({id:v.id,modello:v.modello,posti:v.posti_totali,euro_km:v.euro_km,turno_start:v.start,turno_fine:v.fine,manual:v.manual})));
    if(vehicles.length!==2)throw new Error('Non sono stati caricati entrambi i veicoli');
    const formations=aggregate(req,Math.max(...vehicles.map(v=>num(v.posti_totali))));
    log('FORMAZIONI',formations);
    const commercial=await road(origin,dest);
    log('PERCORSO_COMMERCIALE',{km:money(commercial.metres/1000),minuti:money(commercial.seconds/60)});
    const departures=Date.parse(req[0].start_datetime);
    const all=[];
    for(const v of vehicles){
      let to,back;
      try {to=await road({...v,kind:'veicolo'},origin);back=await road(dest,{...v,kind:'veicolo'});}
      catch(e){all.push({veicolo:v.id,errore_routing:e.message});continue;}
      const metres=to.metres+commercial.metres+back.metres;
      const cost=Math.ceil(metres/1000*num(v.euro_km)*100)/100;
      const start=departures-to.seconds*1000;
      const end=departures+commercial.seconds*1000+back.seconds*1000;
      const turnOK=shiftValid(v,start,end);
      let conflictList=[],conflictError=null;
      try{conflictList=await conflicts(client,num(v.id),start,end);}catch(e){conflictError=e.message;}
      const rows=formations.filter(f=>f.seats<=num(v.posti_totali)).map(f=>({
        veicolo:num(v.id),formazione:f.ids,posti:f.seats,ricavo_euro:money(f.revenue),
        km_avvicinamento:money(to.metres/1000),km_commerciali:money(commercial.metres/1000),
        km_ritorno:money(back.metres/1000),km_totali:money(metres/1000),
        costo_completo_euro:cost,margine_euro:money(f.revenue-cost),
        partenza_base:iso(start),ritorno_base:iso(end),
        turno_ok:turnOK,conflitti:conflictList,errore_conflitti:conflictError,
        partenza_futura:start>Date.now(),
        ammissibile_test_futuro:money(f.revenue-cost)>0 && turnOK && !conflictError && !conflictList.length && start>Date.now()
      }));
      all.push(...rows);
    }
    log('VALUTAZIONE_PER_FORMAZIONE',all);
    const target=all.filter(r=>Array.isArray(r.formazione)&&r.formazione.join(',')==='27,28,29');
    log('FOCUS_27_28_29',target);
    log('CONCLUSIONE',{chiamate_routing:routes,formazione_completa_valutata:target.length,
      candidati_futuro_ammissibili:target.filter(r=>r.ammissibile_test_futuro).map(r=>r.veicolo),
      nota:'La ammissibilita qui replica solo i filtri FUTURO del test flotta; NON certifica soglie EXPRESS, pagamenti, commissioni, raggio, qualita o rivalidazione transazionale. Turni interpretati come fascia ricorrente Europe/Rome.'});
  } catch(e) {
    console.error('[TEST_ERROR]',e.stack||e.message);
    process.exitCode=1;
  } finally {
    if(client){try{await client.query('ROLLBACK');console.log('\n[TRANSAZIONE] ROLLBACK');}catch(e){console.error('[ROLLBACK_ERROR]',e.message);}client.release();}
    await pool.end();
  }
}
await main();
