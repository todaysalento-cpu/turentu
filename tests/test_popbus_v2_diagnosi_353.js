// TURENTU POPBUS V2 — DIAGNOSI MIRATA VEICOLO / ATTIVAZIONE | READ ONLY
// Salva come tests/test_popbus_v2_diagnosi_353.js
// Esegui: node --env-file=.env tests\test_popbus_v2_diagnosi_353.js
// Non esegue worker, non chiama Google Maps, non modifica schema o record.
import { pool } from '../db/db.js';

const VEHICLE_ID = Number(process.env.POPBUS_DIAG_VEHICLE_ID || 353);
const ACTIVATION_ID = Number(process.env.POPBUS_DIAG_ACTIVATION_ID || 5);
const REQUEST_IDS = [20, 21];
const START = '2026-10-13T07:05:22.000Z';
const END = '2026-10-13T13:46:59.000Z';
const report = (label, value) => console.log(`[${label}] ${JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v, 2)}`);
const qname = name => '"' + name.replaceAll('"','""') + '"';
const clock = new Intl.DateTimeFormat('it-IT', {timeZone:'Europe/Rome',dateStyle:'full',timeStyle:'medium'});
const safeDate = value => {try{return value ? clock.format(new Date(value)) : null;}catch{return null;}};

async function columns(client, table) {
 const {rows} = await client.query(`SELECT column_name, data_type, udt_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,[table]);
 return rows;
}
function pick(cols, names) {return names.find(name=>cols.some(c=>c.column_name===name));}
async function selectedRows(client, table, key, id, fields) {
 const cols=await columns(client,table);
 if(!cols.length)return {table,stato:'TABELLA_ASSENTE',columns:[]};
 const allowed=fields.filter(f=>cols.some(c=>c.column_name===f));
 if(!cols.some(c=>c.column_name===key))return {table,stato:'CHIAVE_ASSENTE',columns:cols};
 const sql=`SELECT ${allowed.length?allowed.map(qname).join(', '):qname(key)} FROM public.${qname(table)} WHERE ${qname(key)}=$1 LIMIT 30`;
 const {rows}=await client.query(sql,[id]);
 return {table,stato:'OK',righe:rows,columns:cols};
}
async function main(){
 let client, tx=false;
 console.log('TURENTU POPBUS V2 — DIAGNOSI DISPONIBILITA E CONFLITTI | READ ONLY');
 try {
  client=await pool.connect();
  await client.query('BEGIN READ ONLY');tx=true;
  await client.query("SET LOCAL statement_timeout = '20000ms'");
  const state=(await client.query("SELECT current_database() db,current_setting('transaction_read_only') read_only,now() now")).rows[0];
  if(state.read_only!=='on')throw Error('Transazione non read-only');
  report('CONNESSIONE',state);
  report('CICLO_IN_ESAME',{veicolo:VEHICLE_ID,richieste:REQUEST_IDS,busy_start_utc:START,busy_end_utc:END,busy_start_roma:safeDate(START),busy_end_roma:safeDate(END),simulazione_storica:true});
  const v=await selectedRows(client,'veicolo','id',VEHICLE_ID,['id','driver_id','posti_totali','targa','marca','modello','localita','raggio_km']);
  report('VEICOLO',{stato:v.stato,righe:v.righe,columns:v.stato==='OK'?undefined:v.columns});
  const dvcols=await columns(client,'disponibilita_veicolo');
  if(dvcols.length && dvcols.some(c=>c.column_name==='veicolo_id')){
   const keep=['id','veicolo_id','start','fine','manual','giorni_esclusi','inattivita','created_at','updated_at','attivo'];
   const fields=keep.filter(f=>dvcols.some(c=>c.column_name===f));
   const {rows}=await client.query(`SELECT ${fields.map(qname).join(',')} FROM public.disponibilita_veicolo WHERE veicolo_id=$1 ORDER BY ${dvcols.some(c=>c.column_name==='id')?'id':'veicolo_id'} LIMIT 50`,[VEHICLE_ID]);
   report('DISPONIBILITA_VEICOLO',{righe:rows,numero_righe:rows.length,colonne:dvcols});
   report('TURNI_ORARIO_LOCALE',rows.map((r,i)=>({riga:i+1,start_raw:r.start,fine_raw:r.fine,start_roma:safeDate(r.start),fine_roma:safeDate(r.fine),giorni_esclusi:r.giorni_esclusi,inattivita:r.inattivita,manual:r.manual})));
  }else report('DISPONIBILITA_VEICOLO',{stato:'TABELLA_O_CHIAVE_ASSENTE',colonne:dvcols});
  const acols=await columns(client,'popbus_attivazioni');
  if(acols.length){
   const fields=['id','veicolo_id','stato','partenza','arrivo','corsa_id','direttrice_id','piano','created_at','updated_at'].filter(f=>acols.some(c=>c.column_name===f));
   const {rows}=await client.query(`SELECT ${fields.map(qname).join(',')} FROM public.popbus_attivazioni WHERE id=$1`,[ACTIVATION_ID]);
   report('ATTIVAZIONE_IN_CONFLITTO',{righe:rows,numero_righe:rows.length,colonne:acols});
   for(const r of rows){
    const p=r.piano && typeof r.piano==='object'?r.piano:{};
    const a=p.busyStart??r.partenza,b=p.busyEnd??r.arrivo;
    report('INTERVALLO_ATTIVAZIONE',{id:r.id,stato:r.stato,busy_start:a,busy_end:b,busy_start_roma:safeDate(a),busy_end_roma:safeDate(b),overlap:a&&b?new Date(a).getTime()<new Date(END).getTime()&&new Date(b).getTime()>new Date(START).getTime():null,chiavi_piano:Object.keys(p)});
   }
   if(acols.some(c=>c.column_name==='veicolo_id')){
    const sql=`SELECT ${fields.map(qname).join(',')} FROM public.popbus_attivazioni WHERE veicolo_id=$1 AND stato IN ('in_attesa_autista','confermata') AND COALESCE((piano->>'busyStart')::timestamptz,partenza)<$3::timestamptz AND COALESCE((piano->>'busyEnd')::timestamptz,arrivo)>$2::timestamptz ORDER BY id LIMIT 30`;
    const {rows:conflicts}=await client.query(sql,[VEHICLE_ID,START,END]);
    report('CONFLITTI_ATTIVAZIONI_ESATTI',{totale:conflicts.length,righe:conflicts.map(r=>({id:r.id,stato:r.stato,partenza:r.partenza,arrivo:r.arrivo,busyStart:r.piano?.busyStart,busyEnd:r.piano?.busyEnd,corsa_id:r.corsa_id,direttrice_id:r.direttrice_id}))});
   }
  }else report('ATTIVAZIONE_IN_CONFLITTO',{stato:'TABELLA_ASSENTE'});
  const rcols=await columns(client,'richieste_pop_bus');
  if(rcols.length){
   const fields=['id','stato','classe','start_datetime','start_node_id','end_node_id','posti_richiesti','prezzo','corsa_id','created_at'].filter(f=>rcols.some(c=>c.column_name===f));
   const {rows}=await client.query(`SELECT ${fields.map(qname).join(',')} FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[REQUEST_IDS]);
   report('RICHIESTE_CICLO',rows);
  }
  report('INTERPRETAZIONE',{nota:'I dati mostrano le condizioni reali del database; non viene simulato un nuovo turno e non vengono ignorati conflitti. La partenza trascorsa non invalida una simulazione storica, ma impedisce una nuova attivazione reale.',verifiche_non_eseguite:['pagamenti','qualita_passeggeri','soglie_specifiche_di_classe','rivalidazione_transazionale']});
 }catch(e){console.error('[ERRORE]',e.stack||e.message);process.exitCode=1;}
 finally{if(client){if(tx){try{await client.query('ROLLBACK');console.log('[TRANSAZIONE] ROLLBACK: nessun record modificato');}catch(e){console.error('[ROLLBACK_ERROR]',e.message);process.exitCode=1;}}client.release();}try{await pool.end();}catch(e){console.error('[POOL_ERROR]',e.message);process.exitCode=1;}}
}
await main();
