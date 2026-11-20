import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedIds,deleteConfirmedTests } from '../scripts/event-discovery-delete-confirmed-tests.mjs';

function fixture(options={}) {
  const events=confirmedIds.map(id=>({id,titolo:'Confirmed '+id,data_inizio:'2026-07-01T00:00:00.000Z'}));
  const candidates=Array.from({length:80},(_,i)=>({id:i+1,state:'pending',auto_publish:false,event_id:null}));
  const calls=[];let deleted=false,saved=false;
  const client={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('FROM pg_constraint'))return{rows:options.linked?[{schema_name:'public',table_name:'corse',column_name:'evento_id',key_count:1}]:[]};
    if(sql.startsWith('SELECT * FROM public.eventi'))return{rows:options.absent?[]:events.map(e=>({...e,
      ...(options.changed&&e.id===1?{titolo:'Changed after approval'}:{})}))};
    if(sql.startsWith('SELECT "evento_id"'))return{rows:[{event_id:1,count:1}]};
    if(sql.includes('FROM pg_trigger'))return{rows:options.triggers?[{tgname:'custom_delete'}]:[]};
    if(sql.includes('FROM information_schema.columns'))return{rows:Object.keys(events[0]).map(column_name=>({column_name}))};
    if(sql.startsWith('SELECT * FROM public.event_discovery_candidates'))return{rows:options.badCandidates?candidates.slice(1):candidates};
    if(sql.startsWith('SELECT count(*)'))return{rows:[{count:deleted?0:18}]};
    if(sql.startsWith('DELETE')){assert.equal(saved,true,'Backup must complete before DELETE');deleted=true;return{rows:confirmedIds.map(id=>({id}))};}
    if(sql==='COMMIT'&&options.commitError)throw new Error('connection lost');
    return{rows:[]};
  }};
  const run=()=>deleteConfirmedTests(client,{reference:{events},backupPath:'test-backup.json',saveBackup:async backup=>{
    if(options.backupError)throw new Error('disk full');
    assert.equal(backup.events.length,18);saved=true;
  }});
  return{calls,run};
}
test('confirmed cleanup writes backup first, deletes exact IDs, checks 80 candidates and commits',async()=>{
  const f=fixture();const result=await f.run();
  assert.equal(result.deleted,18);assert.equal(result.candidatesUnchanged,80);assert.deepEqual(result.deletedIds,confirmedIds);
  assert.equal(f.calls.at(-1).sql,'COMMIT');
  assert.deepEqual(f.calls.find(c=>c.sql.startsWith('DELETE')).args,[confirmedIds]);
});
for(const [name,options,pattern]of[
  ['changed event',{changed:true},/modificato/],['new dependency',{linked:true},/Collegamenti/],
  ['delete trigger',{triggers:true},/Trigger/],['backup failure',{backupError:true},/disk full/],
  ['unexpected candidate set',{badCandidates:true},/candidati/],
])test('cleanup refuses '+name+' before DELETE',async()=>{
  const f=fixture(options);await assert.rejects(f.run,pattern);
  assert.ok(!f.calls.some(c=>c.sql.startsWith('DELETE')));assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
test('repeating a completed cleanup does not delete any other records',async()=>{
  const f=fixture({absent:true});assert.equal((await f.run()).status,'already_absent');
  assert.ok(!f.calls.some(c=>c.sql.startsWith('DELETE')));
});
test('lost COMMIT response is explicitly reported as uncertain',async()=>{
  const f=fixture({commitError:true});await assert.rejects(f.run,e=>e.commitOutcome==='unknown');
});
