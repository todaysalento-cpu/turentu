// TURENTU P0-C8.20D — Diagnostica operativa READ ONLY, nessuna API esterna.
// Usa durate routing gia' osservate: NON certifica routing live o tratta base.
import { pool } from '../db/db.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';
const VEHICLE=353, IDS=[196,197,198,205,206,207];
const M=[{id:118,start:'2026-11-01T13:15:00Z',nodes:[8,5,7]},{id:120,start:'2026-11-01T15:15:00Z',nodes:[8,5,7]}];
const ROUTE={a:1714,b:1901,transfer:2856,kmMission:55.823,kmTransfer:53.029};
const ms=s=>new Date(s).getTime();
const iso=t=>new Date(t).toISOString();
const q=n=>'"'+n.replaceAll('"','""')+'"';
const findings=[];
function result(status,label,detail){findings.push({status,label});console.log(`${status} ${label}${detail?' '+JSON.stringify(detail):''}`);}
let c,begun=false,complete=false;
try {
 c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
 await c.query("SET LOCAL statement_timeout='12000ms'");await c.query("SET LOCAL lock_timeout='1500ms'");
 console.log('=== P0-C8.20D / FATTIBILITA OPERATIVA / READ ONLY ===');
 const t1=ms(M[0].start),t2=ms(M[1].start),dur=(ROUTE.a+ROUTE.b)*1000;
 const firstEnd=t1+dur,transferEnd=firstEnd+ROUTE.transfer*1000,secondEnd=t2+dur,wait=(t2-transferEnd)/1000;
 if(!(t1<firstEnd&&transferEnd<=t2&&t2<secondEnd))throw Error('Missioni/trasferimento temporalmente incompatibili');
 result('PASS','Sequenza temporale teorica e trasferimento', {missione1:[iso(t1),iso(firstEnd)],trasferimento:[iso(firstEnd),iso(transferEnd)],attesaSecondi:wait,missione2:[iso(t2),iso(secondEnd)]});
 result('NON_VERIFICATO','Routing live, tempi di fermata e traffico: durate da test precedenti');
 const req=await c.query('SELECT id,stato,corsa_id,cliente_id,payment_intent_id,posti_richiesti,prezzo,start_datetime FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id',[IDS]);
 if(req.rowCount!==6)throw Error('Fixture incompleto');
 result(req.rows.every(r=>r.stato==='in_attesa'&&r.corsa_id==null)?'PASS':'FAIL','Richieste disponibili nel snapshot');
 const pickup=new Map([[196,t1],[197,t1+ROUTE.a*1000],[198,t1],[205,t2],[206,t2+ROUTE.a*1000],[207,t2]]);
 for(const r of req.rows){const diff=Math.round((pickup.get(Number(r.id))-ms(r.start_datetime))/60000*100)/100;result(Math.abs(diff)<=30?'PASS':'FAIL',`Richiesta ${r.id}: salita entro tolleranza 30 min`,{differenzaMinuti:diff,posti:r.posti_richiesti});}
 result(req.rows.every(r=>Number(r.cliente_id)>0&&r.payment_intent_id)?'PASS':'NON_PRONTO','Cliente e riferimento pagamento per acceptance');
 const vehicle=await c.query('SELECT id,driver_id,posti_totali,raggio_km FROM public.veicolo WHERE id=$1',[VEHICLE]);
 if(vehicle.rowCount!==1)throw Error('Veicolo non trovato');
 const peak=2;result(Number(vehicle.rows[0].posti_totali)>=peak?'PASS':'FAIL','Capienza teorica peak=2 (non sostituisce sweep DB)',vehicle.rows[0]);
 const availability=await c.query('SELECT * FROM public.disponibilita_veicolo WHERE veicolo_id=$1 ORDER BY id',[VEHICLE]);
 result(availability.rowCount?'PASS':'FAIL','Configurazione disponibilita presente',{righe:availability.rowCount});
 for(const a of availability.rows)console.log('DISPONIBILITA CONFIG:',JSON.stringify(a));
 result('NON_VERIFICATO','Copertura del turno ricorrente sull intero busyStart/busyEnd, giorni esclusi e inattivita: richiede verificaTurnoVeicolo e routing base');
 const columns=await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])",[['corse','popbus_attivazioni']]);
 const by=new Map();for(const r of columns.rows){if(!by.has(r.table_name))by.set(r.table_name,new Set());by.get(r.table_name).add(r.column_name);}
 for(const [table,start,end] of [['corse','start_datetime','arrivo_datetime'],['popbus_attivazioni','partenza','arrivo']]){
  const fields=by.get(table);if(!fields?.has(start)||!fields?.has(end)){result('NON_VERIFICATO',`${table}: colonne temporali non trovate`);continue;}
  const states=table==='corse'?['prenotabile','in_corso','da_attivare']:['in_attesa_autista','confermata'];
  const r=await c.query(`SELECT id,stato,${q(start)} AS inizio,${q(end)} AS fine FROM public.${q(table)} WHERE veicolo_id=$1 AND ${q(start)}<$3::timestamptz AND ${q(end)}>$2::timestamptz AND stato=ANY($4::text[]) ORDER BY ${q(start)} LIMIT 20`,[VEHICLE,iso(t1),iso(secondEnd),states]);
  result(r.rowCount?'FAIL':'PASS',`${table}: conflitti visibili durante le missioni`,{numero:r.rowCount,righe:r.rows});
 }
 result('NON_VERIFICATO','Conflitti sull intervallo busy completo: avvicinamento e ritorno alla base non ancora misurati');
 const tariffs=await c.query("SELECT euro_km FROM public.tariffe WHERE veicolo_id=$1 AND tipo='standard' AND euro_km>0 ORDER BY euro_km LIMIT 1",[VEHICLE]);
 if(!tariffs.rowCount)throw Error('Tariffa standard non disponibile');
 const economy=valutaEconomiaCiclo({ricaviRichiesteEuro:req.rows.map(r=>Number(r.prezzo)),kmAvvicinamento:0,kmMissioni:2*ROUTE.kmMission,kmTrasferimenti:ROUTE.kmTransfer,kmRitornoBase:0,euroKm:Number(tariffs.rows[0].euro_km)});
 result(!economy.economicamenteAttivabile?'PASS':'NON_VERIFICATO','Gate economico limite inferiore (avvicinamento/ritorno/attesa=0)',{economicamenteAttivabile:economy.economicamenteAttivabile,centesimi:economy.centesimi});
 result('NON_VERIFICATO','Raggio base, geometria stradale, approccio/rientro e fattibilita completa: NON certificati');
 complete=true;
} catch(e){console.error('ERRORE:',e.stack??e);process.exitCode=1;}
finally{
 if(c){if(begun){try{await c.query('ROLLBACK');console.log('ROLLBACK READ ONLY completato');}catch(e){console.error('ERRORE ROLLBACK',e);process.exitCode=1;}}c.release();}
 await pool.end();
 const failed=findings.filter(f=>f.status==='FAIL').length;
 console.log(`ESITO: ${findings.filter(f=>f.status==='PASS').length} PASS, ${failed} FAIL, ${findings.filter(f=>f.status==='NON_VERIFICATO'||f.status==='NON_PRONTO').length} NON VERIFICATI/NON PRONTI — ${complete?'DIAGNOSTICA COMPLETATA':'INCOMPLETA'}`);
 console.log('NON E UNA CERTIFICAZIONE DI FATTIBILITA OPERATIVA O ATTIVAZIONE.');
 if(!complete||failed)process.exitCode=1;
}
