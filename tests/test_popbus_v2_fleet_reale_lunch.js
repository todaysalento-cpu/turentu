/**
 * TURENTU POPBUS V2 - FLEET REALE (SHADOW / READ ONLY)
 * node --env-file=.env tests/test_popbus_v2_fleet_reale_lunch.js
 *
 * Legge dati reali in transazione READ ONLY. Non modifica il worker e non
 * attiva corse. Il routing esistente può comportare costi Google Maps.
 *
 * LAUNCH vs PROFIT: confronto preliminare e confronto filtrato dopo audit
 * di tutti i candidati su turni, conflitti veicolo e raggio stradale.
 * Include scenario esplorativo separato per routing di punti vicini.
 * NON certifica Stripe, qualità produttiva o attivabilità.
 * Le classi sono gestite dal pricing, non sono soglie aggiuntive del matching.
 */
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.js';
// Audit indipendente dei candidati selezionati: non attribuisce validazione produttiva.

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
// Importi in centesimi, stessa commissione del generatore (15% del lordo).
const euro2cents=x=>Math.round(Number(x)*100);
const cents2euro=x=>Math.round(x)/100;
function auditEconomicoControfattuale(c,v) {
  const revenue=euro2cents(c.ricavo_euro);
  const commission=Math.round(revenue*1500/10000);
  const net=revenue-commission;
  const km=Number(c.km_totali);
  if(!Number.isFinite(km)||km<0||!Number.isFinite(revenue))return null;
  const driverCost=Math.ceil(km*Number(v.euro_km)*100-1e-9);
  // Il costo di attesa e' indipendente dalla tariffa simbolica.
  const waiting=euro2cents(c.costo_attesa_euro||0);
  const full=driverCost+waiting;
  const threshold=Math.ceil(full*10000/8500);
  const margin=net-full;
  return {
    richieste:c.richieste,
    km_ciclo_completo:km,
    ricavo_lordo_euro:cents2euro(revenue),
    commissione_turentu_euro:cents2euro(commission),
    ricavo_netto_euro:cents2euro(net),
    costo_autista_euro:cents2euro(driverCost),
    costo_attesa_euro:cents2euro(waiting),
    costo_totale_euro:cents2euro(full),
    soglia_lorda_teorica_euro:cents2euro(threshold),
    deficit_euro:cents2euro(Math.max(0,-margin)),
    margine_netto_euro:cents2euro(margin),
    esito_economico:margin>=0?'SOSTENIBILE':'SOTTO_SOGLIA'
  };
}
// Solo scenario esplorativo: non trasforma routing incerto in certificazione.
const NEAR_RADIUS_METRES=bounded('POPBUS_TEST_NEAR_RADIUS_METRES',8,0,30);
const log=(name,obj)=>console.log(`[${name}] ${JSON.stringify(obj,null,2)}`);
const finite=(x)=>Number.isFinite(Number(x));
const validCoord=p=>p&&finite(p.lat)&&finite(p.lon)&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lon))<=180;
function straightMetres(a,b) {
  const rad=Math.PI/180, p1=Number(a.lat)*rad,p2=Number(b.lat)*rad;
  const dlat=p2-p1,dlon=(Number(b.lon)-Number(a.lon))*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dlon/2)**2;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));
}
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
    const metres=Number(r.metres);
    const seconds=Number(r.seconds);
    const normale=Number.isFinite(metres)&&Number.isFinite(seconds)&&metres>0&&seconds>0;
    // Accetta zero solo se il planner ha verificato esplicitamente la coincidenza stradale.
    // La sola distanza in linea d'aria NON basta a certificare il segmento.
    const coincidente=r.roadCoincident===true&&metres===0&&seconds===0&&
      straightMetres(a,b)<=NEAR_RADIUS_METRES;
    if(!normale&&!coincidente)throw Error('Routing non valido');
    const result={metres,seconds,roadCoincident:coincidente};
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
/**
 * LAUNCH diagnostico: massimizza richieste distinte, poi margine, poi cicli.
 * Ricerca esatta SOLO sul campione considerato se non si raggiungono limiti.
 * Nessuna validazione produttiva implicita.
 */
function ottimizzaLaunch(candidati, { maxNodi, maxCandidati }) {
  const items = candidati.map((c, i) => ({
    c, i, vehicle: Number(c.veicolo),
    ids: [...new Set(c.richieste.flat().map(Number))],
    start: Date.parse(c.partenza_base), end: Date.parse(c.ritorno_base),
    margin: Math.round(Number(c.margine_ciclo_con_attesa_euro) * 100)
  })).filter(x => x.margin >= 0 && x.ids.length && x.ids.every(Number.isSafeInteger) &&
    Number.isFinite(x.start) && Number.isFinite(x.end) && x.start < x.end);
  items.sort((a, b) => b.ids.length - a.ids.length || b.margin - a.margin || a.i - b.i);
  const truncated = items.length > maxCandidati;
  const arr = items.slice(0, maxCandidati);
  const suffix = new Array(arr.length + 1).fill(0);
  for (let i = arr.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + arr[i].ids.length;
  let nodes = 0, stopped = false;
  let best = { covered: 0, margin: 0, count: 0, picked: [] };
  const usedIds = new Set(), perVehicle = new Map(), picked = [];
  const better = (covered, margin, count) =>
    covered > best.covered || (covered === best.covered &&
      (margin > best.margin || (margin === best.margin && count > best.count)));
  function dfs(i, covered, margin) {
    if (nodes >= maxNodi) { stopped = true; return; }
    nodes++;
    if (better(covered, margin, picked.length))
      best = { covered, margin, count: picked.length, picked: [...picked] };
    if (i === arr.length || covered + suffix[i] < best.covered) return;
    const x = arr[i];
    const busy = perVehicle.get(x.vehicle) || [];
    if (x.ids.every(id => !usedIds.has(id)) &&
        busy.every(y => x.end <= y.start || y.end <= x.start)) {
      x.ids.forEach(id => usedIds.add(id));
      busy.push(x); perVehicle.set(x.vehicle, busy); picked.push(x);
      dfs(i + 1, covered + x.ids.length, margin + x.margin);
      picked.pop(); busy.pop(); x.ids.forEach(id => usedIds.delete(id));
    }
    if (!stopped) dfs(i + 1, covered, margin);
  }
  dfs(0, 0, 0);
  const selected = best.picked.map(x => x.c);
  return {
    richiesteCoperte: best.covered, richiesteIds: [...new Set(selected.flatMap(c => c.richieste.flat()))].sort((a,b)=>a-b),
    margineTotaleEuro: best.margin / 100, cicliSelezionati: best.count,
    veicoliUsati: [...new Set(selected.map(c => c.veicolo))], selezionati: selected,
    candidatiInput: candidati.length, candidatiValutati: arr.length,
    candidatiTagliati: Math.max(0, items.length - arr.length), nodiEsplorati: nodes,
    ottimoSulCampione: !truncated && !stopped,
    limiteNodiRaggiunto: stopped,
    nota: 'DIAGNOSTICO: nessuna certificazione operativa; ottimo solo sul campione senza tagli.'
  };
}


// Audit SHADOW: non utilizza gli adattatori fail-closed come scorciatoia.
// Le verifiche sono diagnostiche e non autorizzano attivazioni.
const romeMinutesFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const romeWeekdayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome', weekday: 'short'
});
const weekdays = ['sun','mon','tue','wed','thu','fri','sat'];
const dayNames = ['domenica','lunedi','martedi','mercoledi','giovedi','venerdi','sabato'];
function minuteRome(ms) {
  const p = romeMinutesFmt.formatToParts(new Date(ms));
  return Number(p.find(x => x.type === 'hour').value) * 60 +
    Number(p.find(x => x.type === 'minute').value);
}
function excludedDay(days, ms) {
  if (!Array.isArray(days)) return false;
  const day = weekdays.indexOf(romeWeekdayFmt.format(new Date(ms)).toLowerCase());
  if (day < 0) return true;
  return days.some(x => {
    const v = String(x).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return v === String(day) || (day === 0 && v === '7') ||
      v === weekdays[day] || v === dayNames[day];
  });
}
function inactive(vehicle, start, end) {
  if (!Array.isArray(vehicle.inattivita)) return vehicle.inattivita != null;
  return vehicle.inattivita.some(p => {
    if (!p || typeof p !== 'object') return true;
    const x = Date.parse(p.start ?? p.inizio ?? p.dal ?? p.da);
    const y = Date.parse(p.fine ?? p.end ?? p.al ?? p.a);
    return !Number.isFinite(x) || !Number.isFinite(y) || (x < end && y > start);
  });
}
function shiftOK(vehicle, start, end) {
  if (!(end > start) || !vehicle.start || !vehicle.fine || inactive(vehicle,start,end)) return false;
  const s = minuteRome(Date.parse(vehicle.start));
  const e = minuteRome(Date.parse(vehicle.fine));
  if (s === e) return false;
  for (let t = start; t < end; t = Math.min(end,Math.floor(t/60000)*60000+60000)) {
    const m = minuteRome(t);
    if (!(s < e ? m >= s && m < e : m >= s || m < e)) return false;
    const shiftDay = s > e && m < e ? t - 86400000 : t;
    if (excludedDay(vehicle.giorni_esclusi,shiftDay)) return false;
  }
  return true;
}
async function conflictsForVehicle(client, vehicle, start, end) {
  // Stessa semantica veicolo_id del worker. Le differenze con acceptance sono segnalate.
  const {rows} = await client.query(`
    SELECT 'attivazione' AS origine, a.id::text AS id
    FROM public.popbus_attivazioni a
    WHERE a.veicolo_id=$1 AND a.stato IN ('in_attesa_autista','confermata')
      AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza) < $3::timestamptz
      AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo) > $2::timestamptz
    UNION ALL
    SELECT 'corsa', c.id::text
    FROM public.corse c
    WHERE c.veicolo_id=$1 AND c.stato IN ('prenotabile','in_corso','da_attivare')
      AND c.start_datetime < $3::timestamptz
      AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime > $2::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM public.popbus_attivazioni a
        WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id
          AND a.stato IN ('in_attesa_autista','confermata'))
    UNION ALL
    SELECT 'direttrice', d.id::text
    FROM public.direttrici_virtuali d
    JOIN public.segmenti s ON s.direttrice_id=d.id
    WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata')
      AND d.partenza_prevista < $3::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM public.popbus_attivazioni a
        WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id
          AND a.stato IN ('in_attesa_autista','confermata'))
    GROUP BY d.id,d.partenza_prevista
    HAVING MAX(s.start_datetime + s.tempo_stimato * INTERVAL '1 minute') > $2::timestamptz
  `,[vehicle.id,new Date(start),new Date(end)]);
  return rows;
}
async function walletAudit(client, request) {
  const ref = request.payment_intent_id;
  if (!ref) return {stato:'NEGATO',motivo:'payment_intent_id assente'};
  if (!String(ref).startsWith('wallet_')) {
    return {stato:'NON_VERIFICATO',motivo:'Stripe richiede interrogazione esterna; nessuna chiamata Stripe nel test'};
  }
  const {rows} = await client.query(`
    SELECT COALESCE(SUM(importo),0) AS totale
    FROM public.transazioni_wallet
    WHERE utente_id=$1 AND riferimento_id::text=$2
  `,[request.cliente_id,String(request.request_id)]);
  return Number(rows[0].totale) <= -Number(request.prezzo)
    ? {stato:'OK',tipo:'wallet'} : {stato:'NEGATO',motivo:'addebito wallet non verificato'};
}
function auditQuality(candidate, requestMap) {
  // Coerenza minima di orari, gruppi e posti; NON equivale a verificaQualitaRichieste().
  const issues=[];
  for (const mission of candidate.dettaglio_missioni || []) {
    const depart=Date.parse(mission.partenza),arrive=Date.parse(mission.arrivo);
    if (!(arrive>depart)) issues.push('intervallo missione non valido');
    for (const id of mission.richieste || []) {
      const r=requestMap.get(Number(id));
      if (!r) {issues.push(`richiesta ${id} non presente`);continue;}
      if (Date.parse(r.start_datetime)!==depart)
        issues.push(`richiesta ${id}: orario non identico alla partenza missione`);
    }
  }
  return {stato:issues.length?'NEGATO':'PARZIALE',problemi:issues,
    nota:'Manca verificaQualitaRichieste() sul piano effettivo, inclusi indici salita/discesa e deviazioni'};
}
async function auditLaunch(client, candidates, vehicles, requests, nodes) {
  const vehicleMap=new Map(vehicles.map(v=>[Number(v.id),v]));
  const requestMap=new Map(requests.map(r=>[Number(r.id),r]));
  const nodeMap=new Map(nodes.map(n=>[Number(n.id),n]));
  const results=[];
  const admitted=[];
  const exploratory=[];
  const conflictCache=new Map();
  const radiusCache=new Map();
  for (const candidate of candidates) {
    const v=vehicleMap.get(Number(candidate.veicolo));
    const start=Date.parse(candidate.partenza_base),end=Date.parse(candidate.ritorno_base);
    const item={veicolo:candidate.veicolo,richieste:candidate.richieste.flat(),
      controlli:{},problemi:[],ammesso_vincoli_operativi:false,certificato:false};
    if (!v || !(end>start)) {
      item.problemi.push('veicolo o intervallo assente');
      results.push(item);continue;
    }
    item.controlli.turni=shiftOK(v,start,end)?'OK':'NEGATO';
    try {
      const ck=`${v.id}|${start}|${end}`;
      if (!conflictCache.has(ck)) conflictCache.set(ck,await conflictsForVehicle(client,v,start,end));
      const conflicts=conflictCache.get(ck);
      item.controlli.conflitti=conflicts.length?'NEGATO':'OK';
      item.conflitti=conflicts;
    } catch(e) {item.controlli.conflitti='ERRORE';item.problemi.push(e.message);}
    // Raggio stradale base -> punto di partenza di OGNI richiesta.
    // Per candidati con un'unica missione, il percorso base -> nodo origine è già
    // calcolato dal generatore ma non esposto nel candidato: road() lo ricava qui.
    const radius=[];
    for (const id of item.richieste) {
      const r=requestMap.get(Number(id));
      const origin=r&&nodeMap.get(Number(r.start_node_id));
      if (!r || !origin || v.raggio_km==null || !Number.isFinite(Number(v.raggio_km)) ||
          Number(v.raggio_km)<0) {
        radius.push({richiesta:id,stato:'NON_VERIFICATO',motivo:'raggio o origine assente'});
        continue;
      }
      try {
        const rk=`${v.id}|${origin.id}`;
        if (!radiusCache.has(rk)) {
          const metres=Number(v.lat)===Number(origin.lat)&&Number(v.lon)===Number(origin.lon)
            ? 0 : (await road(v,origin,'RADIUS')).metres;
          radiusCache.set(rk,metres);
        }
        const metres=radiusCache.get(rk);
        radius.push({richiesta:id,stato:metres/1000<=Number(v.raggio_km)?'OK':'NEGATO',
          km_stradali:Math.round(metres/10)/100,raggio_km:Number(v.raggio_km)});
      }catch(e){
        const straight=straightMetres(v,origin);
        // Una distanza in linea d'aria minima NON certifica un tragitto stradale.
        // Solo se i punti sono praticamente coincidenti, registriamo un caso
        // di sensibilita' da verificare, senza modificare il dato reale.
        if (straight<=NEAR_RADIUS_METRES) {
          radius.push({richiesta:id,stato:'APPROSSIMATO',metri_linea_aria:Math.round(straight*100)/100,
            raggio_km:Number(v.raggio_km),motivo:'Routing non disponibile tra coordinate vicine: scenario esplorativo, non validato'});
        } else radius.push({richiesta:id,stato:'ERRORE',metri_linea_aria:Math.round(straight*100)/100,motivo:e.message});
      }
    }
    item.controlli.raggio=radius.every(x=>x.stato==='OK')?'OK':
      radius.some(x=>x.stato==='NEGATO')?'NEGATO':'NON_VERIFICATO';
    item.raggio=radius;
    const payments=[];
    for (const id of item.richieste) {
      const r=requestMap.get(Number(id));
      payments.push({richiesta:id,...(r?await walletAudit(client,r):
        {stato:'NEGATO',motivo:'richiesta mancante'})});
    }
    item.pagamenti=payments;
    item.controlli.pagamenti=payments.every(x=>x.stato==='OK')?'OK':
      payments.some(x=>x.stato==='NEGATO')?'NEGATO':'NON_VERIFICATO';
    const quality=auditQuality(candidate,requestMap);
    item.controlli.qualita=quality.stato;
    item.qualita=quality;
    item.ammesso_vincoli_operativi=['turni','conflitti','raggio'].every(k=>item.controlli[k]==='OK');
    if (item.ammesso_vincoli_operativi) admitted.push(candidate);
    // Scenario esplorativo separato: turni e conflitti OK, raggio OK oppure
    // incerto solo per punti praticamente coincidenti. NON attivabile.
    const radiusExploratory=radius.length>0 && radius.every(x=>x.stato==='OK'||x.stato==='APPROSSIMATO');
    if (item.controlli.turni==='OK' && item.controlli.conflitti==='OK' && radiusExploratory)
      exploratory.push(candidate);
    item.problemi.push('Qualità produttiva e rivalidazione transazionale non certificate');
    results.push(item);
  }
  const counts={};
  for(const r of results)for(const [k,v] of Object.entries(r.controlli)) {
    if(!counts[k]) counts[k]={};
    counts[k][v]=(counts[k][v]||0)+1;
  }
  return {
    candidati_esaminati:results.length,
    candidati_ammessi_vincoli_operativi:admitted.length,
    candidati_esclusi:results.length-admitted.length,
    riepilogo_controlli:counts,
    controlli:results,
    candidati_certificati:0,
    nota:'Ammissione limitata a turni, conflitti veicolo e raggio. Stripe, qualità produttiva e transazione NON certificate.',
    admitted,exploratory
  };
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
    SELECT v.id,v.driver_id,v.posti_totali,v.raggio_km,t.euro_km,
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

    // Diagnostica per veicolo: ripete la generazione in SHADOW con le stesse
    // richieste e lo stesso routing in cache. Non modifica DB o algoritmo.
    // Una tariffa simbolica serve solo a isolare possibili esclusioni economiche.
    if (process.env.POPBUS_FLEET_DIAG_VEICOLI !== '0') {
      const diagnosticOptions={
        now:new Date(state.now).getTime(),includePast:INCLUDE_PAST,
        maxWaitMin:MAX_WAIT,bufferMin:BUFFER,maxDepth:MAX_DEPTH,
        maxChains:MAX_CHAINS,maxFormations:MAX_FORMATIONS,
        maxGroupRequests:MAX_GROUP,maxAggregateCombos:MAX_AGGREGATE,
        maxCombosPerChainVehicle:MAX_COMBOS,maxTotalChainCombos:MAX_TOTAL,
        nearTransferMetres:NEAR,costoAttesaOra:WAIT_COST
      };
      const rows=[];
      const maximum=bounded('POPBUS_FLEET_DIAG_MAX_VEICOLI',100,1,500);
      for (const v of vehicles.slice(0,maximum)) {
        const real=generated.candidati.filter(c=>Number(c.veicolo)===Number(v.id));
        let cheap=null, error=null, temporal=null, economics=[];
        try {
          // Controfattuale: non e' una tariffa proposta o utilizzabile.
          // Con WAIT_COST > 0 il costo attesa rimane invariato.
          const simulated=await generaCandidatiFlotta({
            requests:usable,nodes:nodes.filter(validCoord),
            vehicles:[{...v,euro_km:0.000001}],road
          },diagnosticOptions);
          cheap=simulated.candidati.length;
          economics=simulated.candidati.map(c=>auditEconomicoControfattuale(c,v))
            .filter(Boolean).sort((a,b)=>b.margine_netto_euro-a.margine_netto_euro);
          if(!real.length && !cheap && !INCLUDE_PAST) {
            const past=await generaCandidatiFlotta({
              requests:usable,nodes:nodes.filter(validCoord),
              vehicles:[{...v,euro_km:0.000001}],road
            },{...diagnosticOptions,includePast:true});
            temporal=past.candidati.length;
          }
        }catch(e){error=String(e.stack||e.message||e);}
        const best=[...real].sort((a,b)=>
          Number(b.margine_ciclo_con_attesa_euro)-Number(a.margine_ciclo_con_attesa_euro))[0];
        const classification=error?'DIAGNOSTICA_INCOMPLETA':
          real.length?'CANDIDATI_PRESENTI':
          cheap>0?'POSSIBILE_ESCLUSIONE_ECONOMICA':
          temporal>0?'POSSIBILE_VINCOLO_TEMPORALE':
          'NESSUN_CANDIDATO_ANCHE_A_TARIFFA_SIMBOLICA';
        rows.push({
          veicolo:Number(v.id),
          tariffa_euro_km:Number(v.euro_km),
          posti_totali:Number(v.posti_totali),
          raggio_km:v.raggio_km==null?null:Number(v.raggio_km),
          candidati_reali:real.length,
          candidati_tariffa_simbolica:cheap,
          candidati_tariffa_simbolica_include_past:temporal,
          classificazione_indicativa:classification,
          migliore_scenario_economico_a_tariffa_reale:economics[0]||null,
          scenari_economici_analizzati:economics.length,
          nota_economica:'Ricalcolo sui cicli generati con tariffa simbolica: non e una prova che la generazione reale avrebbe selezionato gli stessi cicli.',
          migliore_candidato:best?{
            richieste:best.richieste,
            km_totali:best.km_totali,
            ricavo_lordo_euro:best.ricavo_euro,
            commissione_turentu_euro:best.commissione_turentu_euro,
            ricavo_netto_euro:best.ricavo_netto_euro,
            costo_completo_euro:best.costo_completo_euro,
            costo_attesa_euro:best.costo_attesa_euro,
            soglia_attivazione_lorda_euro:best.soglia_attivazione_lorda_euro,
            margine_netto_euro:best.margine_ciclo_con_attesa_euro
          }:null,
          errore:error
        });
      }
      log('FLEET_DIAGNOSTICA_PER_VEICOLO',{
        tipo:'CONTROFATTUALE_SHADOW_NON_PRODUTTIVO',
        veicoli_analizzati:rows.length,
        veicoli_totali:vehicles.length,
        legenda:{
          POSSIBILE_ESCLUSIONE_ECONOMICA:'Con tariffa simbolica genera candidati; la tariffa reale o il costo attesa possono essere determinanti. Non prova il motivo esatto.',
          POSSIBILE_VINCOLO_TEMPORALE:'Con tariffa simbolica e includePast=true genera candidati; verificare partenza base rispetto a now.',
          NESSUN_CANDIDATO_ANCHE_A_TARIFFA_SIMBOLICA:'Possibili vincoli di capienza, disponibilita, routing, tempo, formazione o limiti; non classificati in modo univoco.',
          CANDIDATI_PRESENTI:'Almeno un candidato economico preliminare; verificare audit operativo.'
        },
        avvertenza:'Diagnostica non certificante. La tariffa simbolica NON deve essere applicata a corse reali. Le chiamate routing possono avere costi.',
        righe:rows
      });
    }

    // Il generatore resta preliminare. Audit indipendente, nessuna certificazione.
    const opt=ottimizzaFlotta(generated.candidati,{maxNodi:OPT_NODES,maxCandidati:OPT_CANDIDATES});
    const launch=ottimizzaLaunch(generated.candidati,{maxNodi:OPT_NODES,maxCandidati:OPT_CANDIDATES});
    const audit=await auditLaunch(client,generated.candidati,vehicles,usable,nodes);
    const {admitted,exploratory,...auditPublic}=audit;
    // Non confondere ammissione operativa parziale con certificazione produttiva.
    log('FLEET_LAUNCH_AUDIT_OPERATIVO',auditPublic);
    const profitFiltered=ottimizzaFlotta(admitted,{maxNodi:OPT_NODES,maxCandidati:OPT_CANDIDATES});
    const launchFiltered=ottimizzaLaunch(admitted,{maxNodi:OPT_NODES,maxCandidati:OPT_CANDIDATES});
    log('FLEET_LAUNCH_CONFRONTO_FILTRATO',{
      vincoli_applicati:['turni','conflitti_veicolo','raggio_stradale'],
      candidati_iniziali:generated.candidati.length,
      candidati_ammessi:admitted.length,
      candidati_esclusi:generated.candidati.length-admitted.length,
      profit:{richieste_coperte:profitFiltered.richiesteCoperte,
        richieste_ids:profitFiltered.richiesteIds,cicli:profitFiltered.cicliSelezionati,
        margine_euro:profitFiltered.margineTotaleEuro,
        ottimo_sul_campione:profitFiltered.ottimoSulCampione,
        cicli_selezionati:selectedSummary(profitFiltered)},
      launch:{richieste_coperte:launchFiltered.richiesteCoperte,
        richieste_ids:launchFiltered.richiesteIds,cicli:launchFiltered.cicliSelezionati,
        margine_euro:launchFiltered.margineTotaleEuro,
        ottimo_sul_campione:launchFiltered.ottimoSulCampione,
        cicli_selezionati:selectedSummary(launchFiltered)},
      richieste_non_coperte_launch:usable.map(r=>Number(r.id)).filter(id=>!launchFiltered.richiesteIds.map(Number).includes(id)),
      avvertenza:'FILTRATO PARZIALMENTE: pagamenti Stripe, qualità e accettazione non verificati. Nessuna attivazione.'
    });
    const launchExploratory=ottimizzaLaunch(exploratory,{maxNodi:OPT_NODES,maxCandidati:OPT_CANDIDATES});
    log('FLEET_LAUNCH_SCENARIO_ROUTING_VICINO',{
      tolleranza_m:NEAR_RADIUS_METRES,
      candidati_operativi_verificati:admitted.length,
      candidati_scenario_esplorativo:exploratory.length,
      richieste_coperte:launchExploratory.richiesteCoperte,
      richieste_ids:launchExploratory.richiesteIds,
      richieste_non_coperte:usable.map(r=>Number(r.id)).filter(id=>!launchExploratory.richiesteIds.map(Number).includes(id)),
      cicli_selezionati:selectedSummary(launchExploratory),
      ottimo_sul_campione:launchExploratory.ottimoSulCampione,
      avvertenza:'IPOTESI NON CERTIFICATA: coordinate vicine con routing fallito. Non usare per attivazioni, costi, tempi o validazione del raggio.'
    });
    log('FLEET_LAUNCH_CONFRONTO_DIAGNOSTICO',{ 
      profit:{richieste_coperte:opt.richiesteCoperte,cicli:opt.cicliSelezionati,
        margine_euro:opt.margineTotaleEuro,ottimo_sul_campione:opt.ottimoSulCampione},
      launch:{richieste_coperte:launch.richiesteCoperte,cicli:launch.cicliSelezionati,
        margine_euro:launch.margineTotaleEuro,ottimo_sul_campione:launch.ottimoSulCampione,
        nodi_esplorati:launch.nodiEsplorati,candidati_tagliati:launch.candidatiTagliati},
      differenza_richieste:launch.richiesteCoperte-opt.richiesteCoperte,
      differenza_margine_euro:Math.round((launch.margineTotaleEuro-opt.margineTotaleEuro)*100)/100,
      cicli_launch:selectedSummary(launch),
      avvertenza:'Confronto preliminare con audit diagnostico separato; nessuna attivazione reale.'
    });
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
      routing_senza_errori:generated.diagnostica.routingSenzaErrori&&budgetHits===0&&routeErrors.size===0,
      confronto_10b:'Richiede identico snapshot; confronto LAUNCH/PROFIT sul medesimo campione preliminare',
      candidati_ammessi_vincoli_operativi:admitted.length,
      avvertenza:'Ottimizzazione filtrata per turni/conflitti veicolo/raggio. Stripe, qualità e accettazione NON certificati. Nessuna attivazione.'
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
