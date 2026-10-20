import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'turentu-ar-shadow-'));
const root=process.cwd();
const source=(p)=>readFileSync(join(root,'tests',p),'utf8');
try {
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  for(const [name,src] of [['bridge.js','pixel-ar-shadow-bridge.js.txt'],['registry.js','pixel-ar-registry.js.txt'],['optimizer.js','fleet-optimizer.ar-readonly.js.txt']]) writeFileSync(join(dir,name),source(src));
  const {eseguiPixelArShadow}=await import(pathToFileURL(join(dir,'bridge.js')));
  const {leggiRegistroAr,filtraCandidateAr}=await import(pathToFileURL(join(dir,'registry.js')));
  const {ottimizzaFlotta}=await import(pathToFileURL(join(dir,'optimizer.js')));
  let checks=0;const pass=(name)=>{checks++;console.log('PASS '+name)};
  const group='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const row=(id,ar=false,tratta=null)=>({id,ar_vincolata:ar,ar_group_id:ar?group:null,ar_tratta:tratta,stato:'in_attesa',corsa_id:null});
  const rows=[row(101,true,'andata'),row(201,true,'ritorno'),row(301)];
  const ctx=(id,ids)=>({pixel_opportunita_id:id,pixel_direttrice_id:id+100,versione:1,richiesta_ids:ids,
    requests:rows.filter(r=>ids.includes(r.id)),plan:{nodes:[1,2],legs:[{seconds:600,metres:10000}]},window:{start:1,end:2}});
  const contexts=[ctx(1,[101,301]),ctx(2,[201])];
  const candidate=(id,req,vehicle,margin)=>({_pixelOpportunitaIds:[id],_economiaRicalcolata:true,veicolo:vehicle,richieste:[req],
    partenza_base:2000000000000,ritorno_base:2000003600000,margine_ciclo_con_attesa_euro:margin});
  const props=[candidate(1,101,1,-2),candidate(2,201,2,8),candidate(1,301,3,3)];
  const client={query:async(sql,args)=>({rows:sql.includes('ar_group_id = ANY')?rows.filter(r=>r.ar_vincolata):rows.filter(r=>args[0].includes(r.id))})};
  const deps={client,contesti:contexts,proposte:props,leggiRegistroAr,filtraCandidateAr,ottimizzaFlotta};
  const out=await eseguiPixelArShadow(deps);
  assert.deepEqual(out.scelta.richiesteIds,[101,201,301]);pass('coppia A/R completa su veicoli distinti con margine negativo compensato');
  assert.equal(out.scelta.margineTotaleEuro,9);pass('margine globale effettivo');
  assert.equal(out.diagnostica.dbWrites,0);pass('shadow senza scritture');
  assert.equal(out.registro.arPairs.length,1);pass('registro letto dalla stessa snapshot');
  const noReturn=await eseguiPixelArShadow({...deps,proposte:[props[0],props[2]]});
  assert.deepEqual(noReturn.scelta.richiesteIds,[301]);pass('andata isolata esclusa, ordinaria indipendente');
  const noOut=await eseguiPixelArShadow({...deps,proposte:[props[1],props[2]]});
  assert.deepEqual(noOut.scelta.richiesteIds,[301]);pass('ritorno isolato escluso, ordinaria indipendente');
  const expectFail=async(input,name)=>{await assert.rejects(()=>eseguiPixelArShadow({...deps,...input}));pass(name)};
  await expectFail({proposte:[{...props[0],_economiaRicalcolata:false}]},'economia non rivalutata bloccata');
  await expectFail({proposte:[{...props[0],_pixelOpportunitaIds:[999]}]},'provenienza PIXEL estranea bloccata');
  await expectFail({proposte:[{...props[0],richieste:[[999]]}]},'richiesta fuori opportunita bloccata');
  await expectFail({proposte:props,maxCandidati:2},'limite candidate fail closed');
  await expectFail({contesti:[ctx(1,[101,301])]},'contesto A/R incompleto non utilizzabile');
  await expectFail({proposte:[{...props[0],richieste:[[101,101]]}]},'duplicazione richiesta bloccata');
  assert.equal(out.scelta.arVincoliApplicati,true);pass('optimizer A/R opt-in applicato');
  assert.equal(out.diagnostica.proposteEscluse,0);pass('nessuna esclusione indebita');
  console.log('PIXEL_AR_SHADOW_BRIDGE_JSON:'+JSON.stringify({passed:true,checksPassed:checks,checksTotal:14,dbWrites:0,workerModified:false,scope:'integrazione mock DB + moduli reali; NO commit, NO worker operativo'}));
} finally {rmSync(dir,{recursive:true,force:true})}
