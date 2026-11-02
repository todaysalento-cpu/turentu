'use strict';
const {Client}=require('pg');
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL assente');
const ssl=process.env.TURENTU_RENDER_SSL_DIAGNOSTIC==='1'?{rejectUnauthorized:false}:{rejectUnauthorized:true};
(async()=>{
 const db=new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:10000,application_name:'turentu_5r2_diagnostica_readonly'});
 try{
  await db.connect();
  const {rows:[identity]}=await db.query('SELECT current_database() AS db, pg_backend_pid() AS pid');
  if(identity.db!=='corse_db') throw new Error('Database inatteso: '+identity.db);
  const {rows}=await db.query(`SELECT pid, application_name, state, wait_event_type, wait_event,
    now()-xact_start AS transaction_age, now()-query_start AS query_age,
    pg_blocking_pids(pid) AS blocked_by
    FROM pg_stat_activity
    WHERE datname=current_database()
      AND application_name LIKE 'turentu_5r2_%'
      AND pid<>pg_backend_pid()
    ORDER BY pid`);
  console.log('DATABASE:',identity.db);
  console.table(rows);
  if(rows.length===0) console.log('PASS: nessuna sessione 5R.2 visibile rimasta attiva');
  else console.log('ATTENZIONE: sessioni 5R.2 ancora presenti; non riavviare il test');
 }finally{await db.end().catch(()=>{});}
})().catch(e=>{console.error('STOP:',e.message);process.exitCode=1});
