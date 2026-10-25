// tests/test_pixel_territorial_discovery_v56.js
import { pool } from '../db/db.js';
import { planPixelTerritorialDiscovery } from '../services/pixel/pixel-territorial-discovery-plan.service.js';

let failures=0;
try {
 for(const [nome,istat] of [['BARI','072006'],['LECCE','075035']]) {
  console.log(`\n========== ${nome} (${istat}) ==========`);
  const start=Date.now();
  const r=await planPixelTerritorialDiscovery(istat,{maxGoogleCalls:48});
  const checks={
   limite_chiamate:r.chiamate_google_pianificate<=r.max_google_calls,
   conteggio_piano:r.piano.length===r.chiamate_google_pianificate,
   categorie_coerenti:Object.values(r.categorie).reduce((a,b)=>a+b,0)===r.piano.length,
   centri_coerenti:r.centri_esplorati+r.centri_non_esplorati===r.centri_disponibili,
   confini_istat:r.centri_fuori_comune===0,
   nessuna_chiamata_google:r.diagnostica.nessuna_chiamata_google===true,
   copertura_non_superiore_v552:r.copertura_geometrica_piano_pct<=r.copertura_teorica_v552_pct+0.002,
   sequenza_piano:r.piano.every((c,i)=>c.numero===i+1),
  };
  failures+=Object.values(checks).filter(v=>!v).length;
  console.log(JSON.stringify({comune:r.nome_comune,centri_base:r.centri_base,
   centri_integrativi:r.centri_integrativi,centri_disponibili:r.centri_disponibili,
   centri_esplorati:r.centri_esplorati,centri_non_esplorati:r.centri_non_esplorati,
   copertura_v552_pct:r.copertura_teorica_v552_pct,
   copertura_piano_pct:r.copertura_geometrica_piano_pct,
   chiamate_google_pianificate:r.chiamate_google_pianificate,
   categorie:r.categorie,motivo_arresto:r.motivo_arresto,
   durata_ms:Date.now()-start,
   verifiche:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v?'OK':'ERRORE']))},null,2));
  console.log('Prime 10 chiamate simulate:');
  console.table(r.piano.slice(0,10).map(x=>({numero:x.numero,centro:x.centro_id,
   tipo:x.tipo_centro,categoria:x.categoria,lat:x.lat.toFixed(5),lon:x.lon.toFixed(5)})));
 }
 console.log(`\nESITO: ${failures===0?'VERIFICHE OK':`${failures} VERIFICHE FALLITE`}`);
 if(failures)process.exitCode=1;
} catch(e){console.error('TEST FALLITO:',e);process.exitCode=1;}
finally{await pool.end();}
