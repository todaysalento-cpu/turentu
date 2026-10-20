// TURENTU — C6.4 rifiuto conflitti PIXEL-first, SOLO DB di sviluppo.
// Richiede worker sospesi e accesso esclusivo alle richieste 196..207.
// Usa prezzi sintetici ×1.60 COMMIT temporaneo (necessario per reader separato),
// backup persistente su disco, ripristino verificato e ROLLBACK delle attivazioni.
// NON e' crash-atomic: se interrotto, eseguire --recover.
// Non prova da solo l'assenza di doppie assegnazioni in LIVE.
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ids = Array.from({length:12},(_,i)=>196+i);
const factor = 1.6;
const backupPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'pixel_first_C6_prezzi_196_207_RECOVERY.json');
const mode = process.argv[2] || '--test';
let exitCode = 0;
const fail = msg => { throw new Error(msg); };
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const cents = n => Math.round(Number(n)*100);

async function identity(client) {
  const {rows:[r]}=await client.query('SELECT current_database() AS db, current_schema() AS schema, inet_server_addr()::text AS host');
  if (r.db !== 'corse_db') fail(`DB ${r.db}: consentito solo corse_db`);
  if (process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED === '1') fail('LIVE_APPROVED=1: interrompere');
  if (process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST === 'true') fail('Flag LIVE acceptance abilitato: interrompere');
  if (process.env.POPBUS_PIXEL_FIRST_MODE === 'LIVE') fail('POPBUS_PIXEL_FIRST_MODE=LIVE: interrompere');
  if (process.env.POPBUS_PIXEL_TEST_EXCLUSIVE !== 'YES') fail('Impostare POPBUS_PIXEL_TEST_EXCLUSIVE=YES solo dopo aver fermato tutti i worker e verificato DB di sviluppo');
  console.log('DB verificato:',r);
}
async function getPrices(client) {
  const {rows}=await client.query(`SELECT id, prezzo::text AS prezzo, stato, corsa_id
    FROM public.richieste_pop_bus WHERE id=ANY($1::integer[]) ORDER BY id`,[ids]);
  if(rows.length!==ids.length || !same(rows.map(r=>Number(r.id)),ids)) fail('Le 12 richieste non corrispondono');
  return rows;
}
async function saveBackup(data) {
  const tmp=backupPath+'.tmp';
  await writeFile(tmp,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
  await rename(tmp,backupPath);
}
async function readBackup() {
  const data=JSON.parse(await readFile(backupPath,'utf8'));
  if(data.version!==1 || data.db!=='corse_db' || !Array.isArray(data.rows) || data.rows.length!==12 ||
    !same(data.rows.map(r=>Number(r.id)),ids) || data.rows.some(r=>!Number.isInteger(cents(r.prezzo))))
    fail('Backup non valido: ripristino manuale necessario');
  return data;
}
async function updatePrices(client, values, expected) {
  await client.query('BEGIN');
  try {
    const rows=await getPrices(client);
    if (!same(rows,expected)) fail('Le richieste sono cambiate: nessuna modifica effettuata');
    for(const r of values){
      const result=await client.query('UPDATE public.richieste_pop_bus SET prezzo=$1 WHERE id=$2 AND prezzo=$3',
        [r.prezzo,r.id,rows.find(x=>Number(x.id)===Number(r.id)).prezzo]);
      if(result.rowCount!==1) fail('Concorrenza sul prezzo richiesta '+r.id);
    }
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');throw e;}
}
async function restore(client) {
  const backup=await readBackup();
  const current=await getPrices(client);
  if(!same(current,backup.rows) && !same(current,backup.testRows))
    fail('PREZZI DIVERSI DAL BACKUP E DAL TEST: non sovrascrivo modifiche esterne. Ripristino manuale necessario: '+backupPath);
  if(same(current,backup.testRows)) await updatePrices(client,backup.rows,backup.testRows);
  const restored=await getPrices(client);
  if(!same(restored,backup.rows)) fail('RIPRISTINO NON VERIFICATO: '+backupPath);
  await unlink(backupPath);
  console.log('RIPRISTINO PREZZI VERIFICATO. Backup di recovery rimosso.');
}
// Pool wrapper: soltanto SELECT esatto di conflicts(), senza scritture simulate.
// Si restituisce una riga fittizia per simulare un conflitto sul veicolo.
function poolConConflitto(phase) {
  const counts={reader:0,writer:0};
  const wrapper={
    async connect() {
      const actual=await pool.connect();
      let tx='none';
      return {
        async query(sql,...args) {
          const text=typeof sql==='string'?sql:String(sql?.text||'');
          const norm=text.replace(/\s+/g,' ').trim().toLowerCase();
          if(norm.startsWith('begin transaction isolation level repeatable read read only')) tx='reader';
          else if(norm==='begin') tx='writer';
          if(norm.startsWith('select 1 as found from popbus_attivazioni a') &&
             norm.includes('union all') && norm.includes('from corse c') &&
             norm.includes('from direttrici_virtuali d')) {
            if(tx!=='reader' && tx!=='writer') fail('C6: conflicts() senza transazione riconosciuta');
            counts[tx]++;
            if(phase==='all' || (phase==='writer' && tx==='writer'))
              return {rows:[{found:1}],rowCount:1};
          }
          return actual.query(sql,...args);
        },
        release(...args){return actual.release(...args);}
      };
    }
  };
  return {wrapper,counts};
}
async function runEngine(label, dbPool) {
  console.log(`\n=== ${label} ===`);
  const result=await processaPixelFirstMultimissione({pool:dbPool,mode:'ROLLBACK_ONLY'});
  console.log('RISULTATO_'+label+':',JSON.stringify(result,null,2));
  if(result?.persistita===true) fail('CRITICO: persistita=true in ROLLBACK_ONLY');
  return result;
}
function positive(r) {
  return Number.isSafeInteger(Number(r?.attivazioneId)) && Number(r.attivazioneId)>0 &&
    Number.isSafeInteger(Number(r?.offertaId)) && Number(r.offertaId)>0 &&
    r.modo==='ROLLBACK_ONLY' && r.persistita===false &&
    Number.isFinite(Number(r.margineEuro)) && Number(r.margineEuro)>0;
}
let client;
let backupCreated=false;
try {
  if(!['--test','--recover'].includes(mode)) fail('Uso: --test oppure --recover');
  client=await pool.connect();
  await identity(client);
  if(mode==='--recover') {
    await restore(client);
  } else {
    try {await readFile(backupPath,'utf8');fail('Backup preesistente: eseguire prima --recover');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const before=await getPrices(client);
    if(before.some(r=>r.stato!=='in_attesa' || r.corsa_id!==null)) fail('Richieste non tutte in_attesa/libere');
    if(before.some(r=>!Number.isFinite(Number(r.prezzo)) || Number(r.prezzo)<=0)) fail('Prezzi originali non validi');
    const testRows=before.map(r=>({...r,prezzo:(Math.round(cents(r.prezzo)*factor)/100).toFixed(2)}));
    await saveBackup({version:1,db:'corse_db',factor,createdAt:new Date().toISOString(),rows:before,testRows});
    backupCreated=true;
    await updatePrices(client,testRows,before);
    client.release();client=null;

    // Controllo positivo: il medesimo scenario deve essere attivabile senza injection.
    const base=await runEngine('CONTROLLO_POSITIVO',pool);
    if(!positive(base)) fail('Controllo positivo non attivabile: impossibile certificare C6');

    // C6.4A: conflitto su TUTTI i veicoli nel reader: nessun ciclo selezionabile.
    const a=poolConConflitto('all');
    const shadow=await runEngine('C6_SHADOW_CONFLITTO',a.wrapper);
    console.log('C6_SHADOW_INTERCETTAZIONI:',a.counts);
    if(a.counts.reader<1) fail('C6.4A: nessuna query conflicts() intercettata nel reader');
    if(a.counts.writer!==0) fail('C6.4A: writer raggiunto nonostante tutti i veicoli occupati');
    if(shadow?.attivazioneId || shadow?.offertaId || Number(shadow?.offerte||0)!==0)
      fail('C6.4A: ciclo creato nonostante conflitto SHADOW');
    console.log('PASS C6.4A: conflitto simulato nel reader; nessuna attivazione selezionata.');

    // C6.4B: reader libero, conflitto introdotto solo nel writer.
    const b=poolConConflitto('writer');
    let caught;
    try {await runEngine('C6_WRITER_CONFLITTO',b.wrapper);}
    catch(e){caught=e;}
    console.log('C6_WRITER_INTERCETTAZIONI:',b.counts);
    if(b.counts.reader<1 || b.counts.writer<1)
      fail('C6.4B: reader o writer non hanno invocato conflicts()');
    if(!caught || !String(caught.message||caught).includes('PIXEL_FIRST_MULTI: veicolo in conflitto'))
      fail('C6.4B: errore atteso di conflitto non osservato: '+String(caught?.stack||caught));
    console.log('PASS C6.4B: rivalidazione writer ha respinto il conflitto e propagato errore.');

    client=await pool.connect();
    const after=await getPrices(client);
    if(!same(after,testRows)) fail('C6: prezzi alterati prima del ripristino');
    const {rows:[integrity]}=await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.richieste_pop_bus
          WHERE id=ANY($1::integer[]) AND (stato<>'in_attesa' OR corsa_id IS NOT NULL)) AS richieste_alterate,
        (SELECT COUNT(*)::int FROM public.popbus_attivazione_richieste
          WHERE richiesta_id=ANY($1::integer[])) AS associazioni_residue`,[ids]);
    console.log('C6_INTEGRITA:',integrity);
    if(integrity.richieste_alterate!==0 || integrity.associazioni_residue!==0)
      fail('C6: residui rilevati, fermarsi');
    console.log('PASS C6.4: SHADOW e writer hanno respinto i conflitti simulati, senza residui.');
  }
} catch(e) {
  exitCode=1;
  console.error('TEST FALLITO:',e?.stack||String(e));
} finally {
  if(backupCreated) {
    try {if(!client) client=await pool.connect(); await restore(client);} catch(e) {
      exitCode=1;
      console.error('ATTENZIONE RIPRISTINO NON COMPLETATO:',e?.stack||String(e));
      console.error('NON riavviare i worker. Recovery:',backupPath);
    }
  }
  if(client) client.release();
  try {await pool.end();}catch(e){exitCode=1;console.error('POOL:',e);}
  process.exitCode=exitCode;
}
