// TURENTU — acceptance economica PIXEL-first, SOLO DB di sviluppo.
// Richiede worker sospesi e accesso esclusivo alle richieste 196..207.
// Usa prezzi sintetici ×1.60 e riferimenti wallet univoci con COMMIT temporaneo (necessario per reader separato),
// backup persistente su disco, ripristino verificato di prezzi/riferimenti e ROLLBACK delle attivazioni.
// NON è crash-atomic: se il processo/PC si interrompe, eseguire --recover.
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { accettaAttivazione } from '../services/popbus/v2/acceptance.js';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ids = Array.from({length:12},(_,i)=>196+i);
const factor = 1.6;
const fixtureIds=[196,199,202,203,204,205,206,207];
const assert=(v,m)=>{if(!v)fail('C7: '+m);};
const backupPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'pixel_first_prezzi_196_207_RECOVERY.json');
const mode = process.argv[2] || '--preflight';
let exitCode = 0;
const fail = msg => { throw new Error(msg); };
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const cents = n => Math.round(Number(n)*100);

async function identity(client) {
  const {rows:[r]}=await client.query('SELECT current_database() AS db, current_schema() AS schema, inet_server_addr()::text AS host');
  if (r.db !== 'corse_db') fail(`DB ${r.db}: consentito solo corse_db`);
  if (process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED === '1') fail('LIVE_APPROVED=1: interrompere');
  if (process.env.POPBUS_PIXEL_FIRST === '1') fail('POPBUS_PIXEL_FIRST deve essere OFF');
  if (process.env.POPBUS_PIXEL_TX_STAGING !== 'ROLLBACK_ONLY') fail('Impostare POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY');
  if (process.env.POPBUS_PIXEL_TEST_EXCLUSIVE !== 'YES') fail('Impostare POPBUS_PIXEL_TEST_EXCLUSIVE=YES solo dopo aver fermato tutti i worker e verificato DB di sviluppo');
  console.log('DB verificato:',r);
}
async function getPrices(client) {
  const {rows}=await client.query(`SELECT id, prezzo::text AS prezzo, payment_intent_id, stato, corsa_id
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
  if(data.version!==2 || data.db!=='corse_db' || !Array.isArray(data.rows) || data.rows.length!==12 ||
    !same(data.rows.map(r=>Number(r.id)),ids) || data.rows.some(r=>!Number.isInteger(cents(r.prezzo)) || typeof r.payment_intent_id!=='string'))
    fail('Backup non valido: ripristino manuale necessario');
  return data;
}
async function updatePrices(client, values, expected) {
  await client.query('BEGIN');
  try {
    const rows=await getPrices(client);
    if (!same(rows,expected)) fail('Le richieste sono cambiate: nessuna modifica effettuata');
    for(const r of values){
      const old=rows.find(x=>Number(x.id)===Number(r.id));
      if(!old) fail('Richiesta assente durante aggiornamento '+r.id);
      const result=await client.query(`UPDATE public.richieste_pop_bus
        SET prezzo=$1, payment_intent_id=$2
        WHERE id=$3 AND prezzo=$4 AND payment_intent_id IS NOT DISTINCT FROM $5`,
        [r.prezzo,r.payment_intent_id,r.id,old.prezzo,old.payment_intent_id]);
      if(result.rowCount!==1) fail('Concorrenza sul prezzo richiesta '+r.id);
    }
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');throw e;}
}
async function restore(client) {
  const backup=await readBackup();
  const current=await getPrices(client);
  if(!same(current,backup.rows) && !same(current,backup.testRows))
    fail('PREZZI/RIFERIMENTI PAGAMENTO DIVERSI DAL BACKUP E DAL TEST: non sovrascrivo modifiche esterne. Ripristino manuale necessario: '+backupPath);
  if(same(current,backup.testRows)) await updatePrices(client,backup.rows,backup.testRows);
  const restored=await getPrices(client);
  if(!same(restored,backup.rows)) fail('RIPRISTINO PREZZI/RIFERIMENTI NON VERIFICATO: '+backupPath);
  await unlink(backupPath);
  console.log('RIPRISTINO PREZZI E RIFERIMENTI WALLET VERIFICATO. Backup di recovery rimosso.');
}

let observed=null;
async function c7Hook(client,created) {
    const ids=created.richiestaIds.map(Number).sort((a,b)=>a-b);
    assert(ids.length===fixtureIds.length && ids.every((id,i)=>id===[...fixtureIds].sort((a,b)=>a-b)[i]),
      'il motore ha scelto richieste diverse dalle fixture autorizzate: test interrotto');
    const {rows:requests}=await client.query(`SELECT id,cliente_id,request_id,prezzo,payment_intent_id,stato
      FROM richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[ids]);
    assert(requests.length===ids.length,'richieste non reperibili');
    assert(requests.every(r=>r.stato==='in_lavorazione' && r.cliente_id && r.request_id &&
      String(r.payment_intent_id).startsWith('wallet_')),
      'fixture non wallet o non valide: vietato interrogare Stripe');
    const {rows:actRows}=await client.query(`SELECT piano FROM popbus_attivazioni WHERE id=$1`,[created.attivazioneId]);
    const plan=actRows[0]?.piano;
    assert(plan?.missioni?.length===2,'non sono state persistite esattamente due missioni');
    const {rows:missionRows}=await client.query(`SELECT count(*)::int AS n FROM popbus_attivazione_missioni WHERE attivazione_id=$1`,[created.attivazioneId]);
    assert(missionRows[0].n===2,'numero missioni DB errato');
    const requestMap=new Map(requests.map(r=>[String(r.request_id),r]));
    let walletChecks=0;
    const walletClient={query:async(sql,params=[])=>{
      const q=String(sql).replace(/\s+/g,' ').trim();
      if (/^SELECT COALESCE\(SUM\(importo\), 0\) AS totale FROM transazioni_wallet WHERE utente_id = \$1 AND riferimento_id::text = \$2$/i.test(q)) {
        const r=requestMap.get(String(params[1]));
        assert(r && Number(r.cliente_id)===Number(params[0]),'identita wallet non coerente');
        walletChecks++;
        return {rows:[{totale:String(-Number(r.prezzo))}],rowCount:1};
      }
      assert(!/transazioni_wallet/i.test(q),'query wallet non riconosciuta');
      return client.query(sql,params);
    }};
    const ride=await accettaAttivazione(walletClient,created.offertaId,created.autistaId);
    assert(ride?.id,'acceptance non ha generato corsa');
    assert(walletChecks===ids.length,'verifiche wallet incomplete');
    const {rows:[counts]}=await client.query(`SELECT
      (SELECT count(*)::int FROM corse WHERE id=$1) AS corse,
      (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$1) AS prenotazioni,
      (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$1) AS pagamenti,
      (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($2::int[]) AND stato='convertita' AND corsa_id=$1) AS convertite,
      (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$3 AND stato='confermata' AND corsa_id=$1) AS confermate,
      (SELECT count(*)::int FROM offerte_autisti WHERE id=$4 AND stato='accettata') AS offerte_accettate`,
      [ride.id,ids,created.attivazioneId,created.offertaId]);
    assert(counts.corse===1 && counts.prenotazioni===ids.length && counts.pagamenti===ids.length &&
      counts.convertite===ids.length && counts.confermate===1 && counts.offerte_accettate===1,
      'conversione incompleta: '+JSON.stringify(counts));
    observed={corsaId:ride.id,attivazioneId:created.attivazioneId,offertaId:created.offertaId,
      richieste:ids,missioni:2,peak:created.peak,margineEuro:created.margineEuro,walletChecks,counts};
    console.log('C7_ACCEPTANCE_IN_TRANSACTION_PASS',JSON.stringify(observed));
}
async function verifyRollback() {
  assert(observed,'acceptance non osservata');
  const {rows:[residue]}=await pool.query(`SELECT
    (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$1) AS attivazioni,
    (SELECT count(*)::int FROM offerte_autisti WHERE id=$2) AS offerte,
    (SELECT count(*)::int FROM corse WHERE id=$3) AS corse,
    (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$3) AS prenotazioni,
    (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$3) AS pagamenti,
    (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($4::int[]) AND stato='convertita' AND corsa_id=$3) AS convertite`,
    [observed.attivazioneId,observed.offertaId,observed.corsaId,observed.richieste]);
  assert(Object.values(residue).every(x=>x===0),'RESIDUI POST ROLLBACK: '+JSON.stringify(residue));
  console.log('C7_ROLLBACK_VERIFICATO_PASS',JSON.stringify(residue));
}
let client;
let backupCreated=false;
try {
  if(!['--preflight','--test','--recover'].includes(mode)) fail('Uso: --preflight, --test, --recover');
  client=await pool.connect();
  await identity(client);
  if(mode==='--recover') {
    await restore(client);
  } else {
    try {await readFile(backupPath,'utf8');fail('Backup preesistente: eseguire prima --recover');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const before=await getPrices(client);
    assert(before.every(r=>r.stato==='in_attesa' && r.corsa_id===null),'fixture non libere');
    assert(before.every(r=>Number(r.prezzo)>0),'prezzi invalidi');
    if(mode==='--preflight') {
      const {rows}=await client.query(`SELECT id,cliente_id,request_id,payment_intent_id,stato,corsa_id
        FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[fixtureIds]);
      assert(rows.length===fixtureIds.length,'fixture mancanti');
      assert(rows.every(r=>Number(r.cliente_id)===4 && r.request_id && String(r.payment_intent_id).startsWith('wallet_')),
        'fixture non wallet o cliente non atteso');
      const {rows:dupes}=await client.query(`SELECT stripe_payment_intent, count(*)::int AS n
        FROM public.pagamenti WHERE stripe_payment_intent IS NOT NULL
        GROUP BY stripe_payment_intent HAVING count(*)>1 LIMIT 5`);
      assert(dupes.length===0,'pagamenti già presenti con riferimenti Stripe duplicati: '+JSON.stringify(dupes));
      console.log('C7_PREFLIGHT_PASS: fixture e prezzi originali verificati; nessuna scrittura');
    } else {
      if(process.env.C7_PRODUCTION_DB_TEST_APPROVED!=='YES')
        fail('Per --test impostare C7_PRODUCTION_DB_TEST_APPROVED=YES dopo controllo trigger e worker');
      if(process.env.C7_EXTERNAL_EFFECTS_REVIEWED!=='YES')
        fail('Controllare prima trigger/effetti esterni: C7_EXTERNAL_EFFECTS_REVIEWED=YES');
      client.release();client=null;
      const baseline=await processaPixelFirstMultimissione({pool,mode:'ROLLBACK_ONLY'});
      assert(!baseline?.attivazioneId && Number(baseline?.offerte||0)===0,'baseline inattesa');
      client=await pool.connect();
      const testRows=before.map(r=>({...r,
        prezzo:(Math.round(cents(r.prezzo)*factor)/100).toFixed(2),
        payment_intent_id:`wallet_pixel_c7_${Number(r.id)}`}));
      await saveBackup({version:2,db:'corse_db',factor,createdAt:new Date().toISOString(),rows:before,testRows});
      backupCreated=true;
      console.log('BACKUP_RECOVERY_CREATO',backupPath);
      await updatePrices(client,testRows,before);
      client.release();client=null;
      process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST='true';
      const result=await processaPixelFirstMultimissione({pool,mode:'ROLLBACK_ONLY',rollbackTestHook:c7Hook});
      assert(result?.persistita===false,'ROLLBACK_ONLY non confermato');
      await verifyRollback();
    }
  }
} catch(e) {
  exitCode=1;
  console.error('C7_FAIL:',e?.stack||String(e));
} finally {
  if(backupCreated) {
    try {if(!client)client=await pool.connect();await restore(client);console.log('C7_PREZZI_RIPRISTINATI_PASS');}
    catch(e){exitCode=1;console.error('C7_RECOVERY_REQUIRED:',e?.stack||String(e));console.error('NON RIAVVIARE I WORKER. Eseguire --recover');}
  }
  if(client)client.release();
  try{await pool.end();}catch(e){exitCode=1;console.error(e);}
  process.exitCode=exitCode;
}
