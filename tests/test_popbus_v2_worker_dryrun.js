// tests/test_popbus_v2_worker_dryrun.js
// DRY RUN: routing reale + lettura PostgreSQL; nessuna scrittura.
import { pool } from '../db/db.js';
import { generaCandidate, generaFormazioniAlternative, scegliAttivazioni } from '../services/popbus/v2/model.js';
import { pianifica, leg } from '../services/popbus/v2/planner.js';

const DATE = '2026-10-16T09:00:00.000Z'; // 11:00 Europe/Rome
const VEHICLE_ID = 353;
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' });
const days = ['sun','mon','tue','wed','thu','fri','sat'];
const minute = t => { const p=fmt.formatToParts(new Date(t)); return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value); };
function excluded(g,t){ if(!Array.isArray(g))return false;const day=days.indexOf(weekday.format(new Date(t)).toLowerCase());const names=['domenica','lunedi','martedi','mercoledi','giovedi','venerdi','sabato'];return g.some(x=>{const v=String(x).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');return v===String(day)||(day===0&&v==='7')||v===names[day]||v===days[day];}); }
function turno(v,a,b){if(!v.start||!v.fine||!(b>a))return false;const s=minute(v.start),e=minute(v.fine);if(s===e)return false;for(let t=a;t<b;t=Math.min(b,Math.floor(t/60000)*60000+60000)){const m=minute(t);if(!(s<e?(m>=s&&m<e):(m>=s||m<e)))return false;const startDay=s>e&&m<e?t-86400000:t;if(excluded(v.giorni_esclusi,startDay))return false;}const periods=v.inattivita||[];if(!Array.isArray(periods))return false;return !periods.some(p=>{if(!p||typeof p!=='object')return true;const x=new Date(p.start??p.inizio??p.dal??p.da).getTime(),y=new Date(p.fine??p.end??p.al??p.a).getTime();return !Number.isFinite(x)||!Number.isFinite(y)||(x<b&&y>a);});}
const movement=async(a,b)=>Math.abs(Number(a.lat)-Number(b.lat))<1e-7&&Math.abs(Number(a.lon)-Number(b.lon))<1e-7?{metres:0,seconds:0}:leg(a,b);
let client;
try {
  console.log('=== POPBUS V2 | DRY RUN WORKER / SOLA LETTURA ===');
  client=await pool.connect();
  await client.query('BEGIN READ ONLY');
  const {rows:nodes}=await client.query(`SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon FROM nodi_direttrice WHERE id=ANY($1::int[])`,[[13,11,12]]);
  if(nodes.length!==3)throw new Error(`Nodi presenti ${nodes.length}/3`);
  const nodeMap=new Map(nodes.map(n=>[Number(n.id),n]));
  const {rows:vehicles}=await client.query(`SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon FROM veicolo v JOIN disponibilita_veicolo dv ON dv.veicolo_id=v.id JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM tariffe WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL WHERE v.id=$1 AND v.driver_id IS NOT NULL AND v.posti_totali>0 AND COALESCE(dv.coord,v.coord) IS NOT NULL`,[VEHICLE_ID]);
  if(vehicles.length!==1)throw new Error(`Veicolo ${VEHICLE_ID}: righe disponibili ${vehicles.length}`);
  const vehicle=vehicles[0];
  const road1=await leg(nodeMap.get(13),nodeMap.get(11));
  const t0=new Date(DATE).getTime();
  const t1=t0+road1.seconds*1000;
  const requests=[
    {id:900001,start_node_id:13,end_node_id:11,start_datetime:new Date(t0),posti_richiesti:4,prezzo:45,classe:'STANDARD'},
    {id:900002,start_node_id:13,end_node_id:12,start_datetime:new Date(t0),posti_richiesti:5,prezzo:60,classe:'STANDARD'},
    {id:900003,start_node_id:11,end_node_id:12,start_datetime:new Date(t1),posti_richiesti:3,prezzo:30,classe:'STANDARD'}
  ];
  const candidate=generaCandidate(requests).find(c=>c.nodes.join('>')==='13>11>12');
  if(!candidate)throw new Error('Candidata 13>11>12 assente');
  const plan=await pianifica(candidate,nodes);
  const alternatives=generaFormazioniAlternative(plan,requests,candidate.seeds,{maxFormazioni:80});
  const evaluation=alternatives.find(e=>e.requests.length===3&&e.occupancy.join(',')==='9,8');
  if(!evaluation)throw new Error('Formazione 3 richieste [9,8] assente');
  const approach=await movement(vehicle,nodeMap.get(plan.nodes[0]));
  const returnTrip=await movement(nodeMap.get(plan.nodes.at(-1)),vehicle);
  const busyStart=evaluation.departure-approach.seconds*1000;
  const busyEnd=evaluation.arrival+returnTrip.seconds*1000;
  const cost=Math.ceil((approach.metres+plan.legs.reduce((s,l)=>s+l.metres,0)+returnTrip.metres)/1000*Number(vehicle.euro_km)*100)/100;
  const validTurn=turno(vehicle,busyStart,busyEnd);
  const {rows:conflicts}=await client.query(`
    SELECT 'attivazione' AS origine,a.id::text AS id,COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza) AS inizio,COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo) AS fine
    FROM popbus_attivazioni a WHERE a.veicolo_id=$1 AND a.stato IN ('in_attesa_autista','confermata') AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza)<$3::timestamptz AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo)>$2::timestamptz
    UNION ALL
    SELECT 'corsa',c.id::text,c.start_datetime,c.arrivo_datetime FROM corse c WHERE c.veicolo_id=$1 AND c.stato IN ('prenotabile','in_corso','da_attivare') AND c.start_datetime<$3::timestamptz AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime>$2::timestamptz) AND NOT EXISTS (SELECT 1 FROM popbus_attivazioni a WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id AND a.stato IN ('in_attesa_autista','confermata'))
    UNION ALL
    SELECT 'direttrice',d.id::text,d.partenza_prevista,MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute') FROM direttrici_virtuali d JOIN segmenti s ON s.direttrice_id=d.id WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata') AND d.partenza_prevista<$3::timestamptz AND NOT EXISTS (SELECT 1 FROM popbus_attivazioni a WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id AND a.stato IN ('in_attesa_autista','confermata')) GROUP BY d.id,d.partenza_prevista HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute')>$2::timestamptz
  `,[VEHICLE_ID,new Date(busyStart),new Date(busyEnd)]);
  const feasible=validTurn&&busyStart>Date.now()&&evaluation.peak<=Number(vehicle.posti_totali)&&evaluation.revenue>=cost&&conflicts.length===0;
  const chosen=scegliAttivazioni(feasible?[{plan,evaluation,vehicle,cost,approach,returnTrip,busyStart,busyEnd}]:[]);
  console.log('Nodi:',plan.nodes.join(' > '),'| segmenti:',plan.legs.length);
  console.log('Richieste:',evaluation.requests,'| occupazione:',evaluation.occupancy,'| picco:',evaluation.peak);
  console.log('Veicolo:',vehicle.id,'| tariffa:',vehicle.euro_km,'| posti:',vehicle.posti_totali);
  console.log('Intervallo operativo:',new Date(busyStart).toISOString(),'->',new Date(busyEnd).toISOString());
  console.log('Turno:',validTurn?'OK':'NO','| Conflitti:',conflicts.length,conflicts);
  console.log('Ricavo:',evaluation.revenue,'EUR | costo:',cost,'EUR | margine soglia:',Number((evaluation.revenue-cost).toFixed(2)),'EUR');
  console.log('Selezionate:',chosen.length,'| Esito:',chosen.length===1?'PASS':'NON ATTIVABILE');
  console.log('NOTA: richieste simulate, nessun pagamento verificato, nessuna scrittura e nessuna offerta emessa.');
  await client.query('ROLLBACK');
} catch(e) {if(client){try{await client.query('ROLLBACK');}catch{}}console.error('FAIL:',e.stack||e.message);process.exitCode=1;} finally {client?.release();await pool.end();}
