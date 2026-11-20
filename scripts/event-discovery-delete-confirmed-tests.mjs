import 'dotenv/config';
import pg from 'pg';
import { readFile, open, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { databaseOptions } from '../config/database.js';

export const confirmedIds = Object.freeze([1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,18,19,20]);
const quote = value => '"'+value.replaceAll('"','""')+'"';
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
async function durable(path, text) {
  await mkdir(dirname(path),{recursive:true});const fd=await open(path,'wx');
  try{await fd.writeFile(text);await fd.sync();}finally{await fd.close();}
}

export async function deleteConfirmedTests(client,{reference,backupPath,saveBackup}) {
  const expected = reference.events;
  if (!Array.isArray(expected) || expected.length!==confirmedIds.length ||
      expected.some(e=>!confirmedIds.includes(e.id)) || new Set(expected.map(e=>e.id)).size!==confirmedIds.length) {
    throw new Error('Lo snapshot non corrisponde ai 18 ID confermati');
  }
  let inTransaction=false,commitAttempted=false;
  try {
    await client.query('BEGIN');inTransaction=true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('SELECT pg_advisory_xact_lock(645019,2)');
    const foreignKeys=(await client.query(`SELECT ns.nspname AS schema_name,cl.relname AS table_name,
      a.attname AS column_name,cardinality(c.conkey) AS key_count,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
      WHERE c.contype='f' AND c.confrelid='public.eventi'::regclass ORDER BY 1,2,3`)).rows;
    if(foreignKeys.some(fk=>fk.key_count!==1))throw new Error('FK composta: pulizia sospesa per revisione');
    const lockTables=[...new Set(['public.eventi',...foreignKeys.map(fk=>quote(fk.schema_name)+'.'+quote(fk.table_name))])].sort();
    await client.query('LOCK TABLE '+lockTables.join(',')+' IN SHARE ROW EXCLUSIVE MODE');
    const rows=(await client.query('SELECT * FROM public.eventi WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',[confirmedIds])).rows;
    if(!rows.length){await client.query('ROLLBACK');inTransaction=false;return{status:'already_absent',deleted:0};}
    if(rows.length!==confirmedIds.length)throw new Error('Alcuni ID risultano cambiati o già eliminati: nessuna cancellazione');
    const expectedMap=new Map(expected.map(e=>[e.id,e]));
    for(const row of rows)if(digest(row)!==digest(expectedMap.get(row.id)))throw new Error('Evento modificato dopo la conferma: ID '+row.id);
    const dependencies=[];
    for(const fk of foreignKeys){
      const sql='SELECT '+quote(fk.column_name)+' AS event_id,count(*)::int AS count FROM '+quote(fk.schema_name)+'.'+quote(fk.table_name)+
        ' WHERE '+quote(fk.column_name)+'=ANY($1::integer[]) GROUP BY '+quote(fk.column_name);
      const linked=(await client.query(sql,[confirmedIds])).rows;
      dependencies.push({...fk,rows:linked});
      if(linked.length)throw new Error('Collegamenti presenti in '+fk.table_name+': nessuna cancellazione');
    }
    const triggers=(await client.query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid='public.eventi'::regclass AND NOT tgisinternal AND tgenabled<>'D' AND (tgtype & 8)=8`)).rows;
    if(triggers.length)throw new Error('Trigger DELETE presenti: serve revisione prima della cancellazione');
    const columns=(await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name='eventi' AND is_generated='NEVER' ORDER BY ordinal_position`)).rows.map(r=>r.column_name);
    const candidatesBefore=(await client.query(`SELECT * FROM public.event_discovery_candidates
      WHERE external_key LIKE 'turentu-live-20261120-%' ORDER BY id`)).rows;
    if(candidatesBefore.length!==80 || candidatesBefore.some(c=>c.state!=='pending'||c.auto_publish||c.event_id!=null)) {
      throw new Error('Gli 80 nuovi candidati non sono nello stato atteso: pulizia sospesa');
    }
    const beforeCount=Number((await client.query('SELECT count(*)::int AS count FROM public.eventi')).rows[0].count);
    const backup={created_at:new Date().toISOString(),purpose:'User-confirmed deletion of 18 test events',
      confirmed_ids:confirmedIds,events:rows,dependencies,triggers,candidates_sha256:digest(candidatesBefore),
      candidates_count:candidatesBefore.length,events_before:beforeCount,columns};
    await saveBackup(backup);
    const deleted=(await client.query('DELETE FROM public.eventi WHERE id=ANY($1::integer[]) RETURNING id',[confirmedIds])).rows.map(r=>r.id).sort((a,b)=>a-b);
    if(digest(deleted)!==digest(confirmedIds))throw new Error('Numero o ID cancellati inattesi: rollback');
    const candidatesAfter=(await client.query(`SELECT * FROM public.event_discovery_candidates
      WHERE external_key LIKE 'turentu-live-20261120-%' ORDER BY id`)).rows;
    if(digest(candidatesAfter)!==digest(candidatesBefore))throw new Error('Candidati modificati: rollback');
    const remaining=Number((await client.query('SELECT count(*)::int AS count FROM public.eventi')).rows[0].count);
    if(remaining!==beforeCount-confirmedIds.length)throw new Error('Conteggio eventi inatteso: rollback');
    await client.query(`INSERT INTO public.event_discovery_audit (actor_id,action,entity_id,details)
      VALUES(NULL,'confirmed-test-events-deleted',NULL,$1)`,[{ids:deleted,backup:backupPath,candidatesUnchanged:80,userConfirmed:true}]);
    commitAttempted=true;await client.query('COMMIT');inTransaction=false;
    return{status:'deleted',deleted:deleted.length,deletedIds:deleted,remainingPublicEvents:remaining,candidatesUnchanged:80,backup:backupPath,published:0};
  }catch(error){if(inTransaction)await client.query('ROLLBACK').catch(()=>{});error.commitOutcome=commitAttempted?'unknown':'rolled_back';throw error;}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv[2]!=='--delete-confirmed-test-events')throw new Error('Usare --delete-confirmed-test-events per i soli 18 ID confermati');
  const reference=JSON.parse(await readFile(new URL('../../event-live-check-1795185724362.json',import.meta.url),'utf8'));
  const backupPath=resolve(`../event-live-deleted-tests-backup-${Date.now()}.json`);
  const restorePath=backupPath.replace(/\.json$/,'.restore.sql');
  const client=new pg.Client({...databaseOptions(),connectionTimeoutMillis:10000});
  try{
    await client.connect();
    const result=await deleteConfirmedTests(client,{reference,backupPath,saveBackup:async backup=>{
      await durable(backupPath,JSON.stringify(backup,null,2)+'\n');
      const columns=backup.columns.map(quote).join(',');
      const json=JSON.stringify(backup.events).replaceAll("'","''");
      const sql=`-- Manual restoration only; not executed by cleanup.\nBEGIN;\nSET LOCAL standard_conforming_strings=on;\n`+
        `INSERT INTO public.eventi (${columns}) OVERRIDING SYSTEM VALUE\nSELECT ${columns} FROM jsonb_populate_recordset(NULL::public.eventi,'${json}'::jsonb);\nCOMMIT;\n`;
      await durable(restorePath,sql);
    }});
    console.log(JSON.stringify({...result,restoreSql:result.deleted?restorePath:undefined}));
  }catch(error){console.error(JSON.stringify({error:error.code||error.message,committed:error.commitOutcome==='unknown'?'unknown':false}));process.exitCode=1;}
  finally{await client.end();}
}
