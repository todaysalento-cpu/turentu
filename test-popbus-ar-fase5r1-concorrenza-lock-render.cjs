'use strict';
// Turentu 5R.1 - verifica reale contesa advisory lock, sola lettura applicativa.
const {Client}=require('pg');
const assert=require('node:assert/strict');
const stop=m=>{throw new Error('5R1 STOP: '+m)};
if(process.env.TURENTU_TEST_AR_CONFIRM!=='ROLLBACK_ONLY')stop('richiesto TURENTU_TEST_AR_CONFIRM=ROLLBACK_ONLY');
if(!process.env.DATABASE_URL)stop('DATABASE_URL assente');
const ssl=process.env.TURENTU_RENDER_SSL_DIAGNOSTIC==='1'?{rejectUnauthorized:false}:{rejectUnauthorized:true};
const makeClient=label=>new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000,application_name:'turentu_5r1_'+label});
const a=makeClient('holder'),b=makeClient('contender');
let aTx=false,bTx=false;
(async()=>{
 try{
  await a.connect();await b.connect();
  const ia=await a.query('SELECT current_database() AS db,pg_backend_pid() AS pid');
  const ib=await b.query('SELECT current_database() AS db,pg_backend_pid() AS pid');
  if(ia.rows[0].db!=='corse_db'||ib.rows[0].db!=='corse_db')stop('database inatteso');
  if(ia.rows[0].pid===ib.rows[0].pid)stop('connessioni non indipendenti');
  console.log('PASS: due connessioni PostgreSQL distinte su corse_db');
  await a.query('BEGIN');aTx=true;
  await b.query('BEGIN');bTx=true;
  await a.query("SET LOCAL statement_timeout='5000ms'");
  await b.query("SET LOCAL statement_timeout='5000ms'");
  // Non attendere su un lock eventualmente detenuto da traffico reale.
  const first=await a.query('SELECT pg_try_advisory_xact_lock(734021,1) AS ok');
  if(first.rows[0].ok!==true)stop('lock globale gia occupato: non eseguire durante accettazioni LIVE');
  console.log('PASS: connessione A acquisisce lock di acceptance (734021,1)');
  const second=await b.query('SELECT pg_try_advisory_xact_lock(734021,1) AS ok');
  assert.equal(second.rows[0].ok,false,'B non deve poter acquisire il lock detenuto da A');
  console.log('PASS: connessione B bloccata dal lock di A (tentativo non bloccante)');
  await a.query('ROLLBACK');aTx=false;
  console.log('PASS: ROLLBACK A rilascia il lock');
  const after=await b.query('SELECT pg_try_advisory_xact_lock(734021,1) AS ok');
  assert.equal(after.rows[0].ok,true,'B deve acquisire il lock dopo il rollback di A');
  console.log('PASS: connessione B acquisisce lock dopo rilascio A');
  await b.query('ROLLBACK');bTx=false;
  console.log('PASS: ROLLBACK B, nessuna scrittura applicativa');
  console.log('PASS: FASE 5R.1, serializzazione lock PostgreSQL verificata');
 }finally{
  if(aTx)await a.query('ROLLBACK').catch(e=>console.error('ATTENZIONE ROLLBACK A:',e.message));
  if(bTx)await b.query('ROLLBACK').catch(e=>console.error('ATTENZIONE ROLLBACK B:',e.message));
  await Promise.allSettled([a.end(),b.end()]);
 }
})().catch(e=>{console.error('STOP:',e.code||'',e.message);process.exitCode=1});
