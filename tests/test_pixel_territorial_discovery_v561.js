// tests/test_pixel_territorial_discovery_v561.js
import { pool } from '../db/db.js';
import { planPixelTerritorialDiscoveryV561 } from '../services/pixel/pixel-territorial-discovery-plan-v561.service.js';
import { planPixelTerritorialDiscovery } from '../services/pixel/pixel-territorial-discovery-plan.service.js';
let failures=0;
try {
 for(const [nome,istat] of [['BARI','072006'],['LECCE','075035']]){
  console.log(`\n========== ${nome} (${istat}) ==========\n`);
  const start=Date.now();
  const previous=await planPixelTerritorialDiscovery(istat,{maxGoogleCalls:48});
  const r=await planPixelTerritorialDiscoveryV561(istat,{maxGoogleCalls:48});
  const uniqueCenters=new Set(r.piano.filter(c=>c.categoria==='trasporto').map(c=>c.centro_id));
  const pairs=new Set(r.piano.map(c=>`${c.centro_id}:${c.categoria}`));
  const checks={
   limite_chiamate:r.piano.length<=48,
   sequenza:r.piano.every((c,i)=>c.numero===i+1),
   categorie:Object.values(r.categorie).reduce((a,b)=>a+b,0)===r.piano.length,
   nessuna_coppia_duplicata:pairs.size===r.piano.length,
   centri_coerenti:r.centri_esplorati+r.centri_non_esplorati===r.centri_disponibili,
   centri_trasporto_unici:uniqueCenters.size===r.centri_esplorati,
   confini_istat:r.centri_fuori_comune===0,
   nessuna_google:r.diagnostica.nessuna_chiamata_google===true,
   nessuna_scrittura:r.diagnostica.nessuna_scrittura===true,
   copertura_valida:r.copertura_geometrica_piano_pct>=0 && r.copertura_geometrica_piano_pct<=r.copertura_teorica_v552_pct+0.002,
  };
  failures+=Object.values(checks).filter(v=>!v).length;
  console.log(JSON.stringify({comune:r.nome_comune,centri_disponibili:r.centri_disponibili,
   centri_esplorati:r.centri_esplorati,centri_non_esplorati:r.centri_non_esplorati,
   copertura_v552_pct:r.copertura_teorica_v552_pct,
   copertura_v56_pct:previous.copertura_geometrica_piano_pct,
   copertura_v561_pct:r.copertura_geometrica_piano_pct,
   differenza_vs_v56_pp:Number((r.copertura_geometrica_piano_pct-previous.copertura_geometrica_piano_pct).toFixed(3)),
   chiamate:r.chiamate_google_pianificate,categorie:r.categorie,
   motivo_arresto:r.motivo_arresto,durata_ms:Date.now()-start,
   verifiche:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v?'OK':'ERRORE']))},null,2));
  console.log('Prime 10 chiamate pianificate:');
  console.table(r.piano.slice(0,10).map(c=>({numero:c.numero,centro:c.centro_id,
   categoria:c.categoria,guadagno_km2:c.guadagno_marginale_km2})));
 }
 console.log(`\nESITO: ${failures?'VERIFICHE FALLITE: '+failures:'VERIFICHE OK'}`);
 if(failures)process.exitCode=1;
} catch(e){console.error('TEST FALLITO:',e);process.exitCode=1;}
finally{await pool.end();}
