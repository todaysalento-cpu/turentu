// services/pixel/pixel-territorial-discovery-plan.service.js
// PIXEL V5.6 DRY_RUN: esclusivamente SELECT; nessuna chiamata Google o persistenza.
import { pool } from '../../db/db.js';
import { generatePixelAdaptiveCenters } from './pixel-territorial-adaptive.service.js';

const CATEGORIES = ['trasporto', 'autobus', 'ferrovia', 'porto', 'aeroporto', 'stadio'];
const distance = (a,b) => {
  const r=Math.PI/180, dlat=(b.lat-a.lat)*r, dlon=(b.lon-a.lon)*r;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2)));
};
const assertInt = (x,name,min,max) => { if(!Number.isSafeInteger(x)||x<min||x>max) throw new Error(`${name} non valido`); };

// Replica esattamente la formula della griglia base V5.5.2.
const BASE_SQL = `WITH comune AS (
 SELECT ST_Transform(geom,32632) AS utm FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1
), celle AS (
 SELECT ST_Transform(ST_PointOnSurface(ST_Intersection(g.geom,c.utm)),4326) AS p
 FROM comune c CROSS JOIN LATERAL ST_SquareGrid($2::float8,c.utm) AS g
 WHERE ST_Area(ST_Intersection(g.geom,c.utm))>0
) SELECT row_number() over (ORDER BY ST_Y(p),ST_X(p)) AS id,
 ST_Y(p) AS lat,ST_X(p) AS lon FROM celle`;

// Controllo reale sui confini ISTAT, non su un raggio dal nodo.
const VERIFY_SQL = `WITH confine AS (
 SELECT geom FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1
), punti AS (
 SELECT x.id, ST_SetSRID(ST_MakePoint(x.lon,x.lat),4326) AS p
 FROM jsonb_to_recordset($2::jsonb) AS x(id text,lat float8,lon float8)
) SELECT p.id FROM punti p CROSS JOIN confine c WHERE NOT ST_Covers(c.geom,p.p)`;

// Copertura geometrica DEL PIANO: unione dei soli cerchi dei centri effettivamente interrogati.
const COVERAGE_SQL = `WITH confine AS (
 SELECT geom FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1
), punti AS (
 SELECT ST_SetSRID(ST_MakePoint(x.lon,x.lat),4326) AS p
 FROM jsonb_to_recordset($2::jsonb) AS x(lat float8,lon float8)
), unione AS (
 SELECT ST_UnaryUnion(ST_Collect(ST_Buffer(p::geography,$3::float8)::geometry)) AS geom FROM punti
) SELECT CASE WHEN u.geom IS NULL THEN 0 ELSE
 100*ST_Area(ST_Intersection(c.geom,u.geom)::geography)/NULLIF(ST_Area(c.geom::geography),0) END AS pct
 FROM confine c CROSS JOIN unione u`;

export async function planPixelTerritorialDiscovery(codiceIstat, {
 database=pool, maxGoogleCalls=48, searchRadiusMeters=1500,
 targetCoveragePercent=98, maxAdditionalCenters=30,
 minMarginalGainM2=100000, gridStepMeters=3000,
 minCenterDistanceMeters=500,
}={}) {
 const codice=String(codiceIstat);
 if(!/^\d{6}$/.test(codice)) throw new Error('Codice ISTAT non valido');
 assertInt(maxGoogleCalls,'maxGoogleCalls',0,500);
 if(!Number.isFinite(searchRadiusMeters)||searchRadiusMeters<100||searchRadiusMeters>5000) throw new Error('searchRadiusMeters non valido');
 const adaptive=await generatePixelAdaptiveCenters(codice,{
  database,searchRadiusMeters,targetCoveragePercent,maxAdditionalCenters,
  minMarginalGainM2,gridStepMeters,minCenterDistanceMeters
 });
 const {rows:baseRows}=await database.query(BASE_SQL,[codice,gridStepMeters]);
 const base=baseRows.map((r,i)=>({id:`${codice}:base:${i+1}`,tipo:'base',lat:Number(r.lat),lon:Number(r.lon)}));
 const extra=adaptive.centri.map(c=>({id:c.id_virtuale,tipo:'integrativo',lat:c.lat,lon:c.lon}));
 if(base.length!==adaptive.centri_base) throw new Error(`Griglia non coerente: ${base.length} != ${adaptive.centri_base}`);
 const all=[...base,...extra];
 const {rows:outside}=await database.query(VERIFY_SQL,[codice,JSON.stringify(all)]);
 if(outside.length) throw new Error(`Centri fuori dal confine ISTAT: ${outside.map(x=>x.id).join(', ')}`);

 // Selezione spaziale farthest-first: prima copre regioni lontane, poi densifica.
 // L'ordine NON equivale a rilevanza per la mobilita o produttivita delle categorie.
 const remaining=[...all], ordered=[];
 while(remaining.length){
  let index=0,score=-1;
  for(let i=0;i<remaining.length;i++){
   const c=remaining[i];
   const d=ordered.length?Math.min(...ordered.map(p=>distance(c,p))):Infinity;
   if(d>score){score=d;index=i;}
  }
  ordered.push(remaining.splice(index,1)[0]);
 }
 // Fase 1: una query bus_stop per centro fino al budget.
 // Fase 2: ulteriori categorie su centri gia visitati, con cap rigoroso.
 const calls=[];
 const add=(center,category)=>calls.push({numero:calls.length+1,centro_id:center.id,
  tipo_centro:center.tipo,lat:center.lat,lon:center.lon,categoria:category,
  metodo:'NEARBY',raggio_m:searchRadiusMeters});
 for(const center of ordered){if(calls.length>=maxGoogleCalls)break;add(center,'trasporto');}
 if(calls.length<maxGoogleCalls){
  for(const category of CATEGORIES.slice(1)){
   for(const center of ordered){if(calls.length>=maxGoogleCalls)break;add(center,category);}
   if(calls.length>=maxGoogleCalls)break;
  }
 }
 const explored=[...new Map(calls.map(c=>[c.centro_id,{id:c.centro_id,lat:c.lat,lon:c.lon}])).values()];
 const {rows:coverage}=await database.query(COVERAGE_SQL,[codice,JSON.stringify(explored),searchRadiusMeters]);
 const byCategory=Object.fromEntries(CATEGORIES.map(k=>[k,calls.filter(c=>c.categoria===k).length]));
 return {
  comune:codice,nome_comune:adaptive.nome_comune,modalita:'DRY_RUN',
  centri_base:base.length,centri_integrativi:extra.length,centri_disponibili:all.length,
  copertura_teorica_v552_pct:adaptive.copertura_finale_percentuale,
  copertura_geometrica_piano_pct:Number(Number(coverage[0]?.pct??0).toFixed(3)),
  centri_esplorati:explored.length,centri_non_esplorati:all.length-explored.length,
  chiamate_google_pianificate:calls.length,max_google_calls:maxGoogleCalls,
  categorie:byCategory,centri_fuori_comune:outside.length,
  motivo_arresto:calls.length>=maxGoogleCalls?'limite_chiamate':'centri_e_categorie_esauriti',
  piano:calls,
  diagnostica:{politica:'farthest_first_spaziale',centri_v552_motivo_arresto:adaptive.motivo_arresto,
   raggio_m:searchRadiusMeters,nessuna_chiamata_google:true,nessuna_scrittura:true},
  avvertenza:'Piano teorico. Copertura dei cerchi, non copertura fermate o risultati Google. Categorie e priorita da validare.'
 };
}
