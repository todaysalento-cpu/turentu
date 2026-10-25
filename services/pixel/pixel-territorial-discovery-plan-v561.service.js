// services/pixel/pixel-territorial-discovery-plan-v561.service.js
// PIXEL V5.6.1: pianificazione DRY_RUN, solo SELECT PostGIS; nessuna API Google, nessuna persistenza.
import { pool } from '../../db/db.js';
import { generatePixelAdaptiveCenters } from './pixel-territorial-adaptive.service.js';

const CATEGORY_QUOTAS = Object.freeze({ autobus: 3, ferrovia: 2, porto: 1, aeroporto: 1, stadio: 1 });
const BASE_SQL = `WITH comune AS (
 SELECT ST_Transform(geom,32632) AS utm FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1
), celle AS (
 SELECT ST_Transform(ST_PointOnSurface(ST_Intersection(g.geom,c.utm)),4326) AS p
 FROM comune c CROSS JOIN LATERAL ST_SquareGrid($2::float8,c.utm) AS g
 WHERE ST_Area(ST_Intersection(g.geom,c.utm))>0
) SELECT ST_Y(p) AS lat, ST_X(p) AS lon FROM celle ORDER BY ST_Y(p),ST_X(p)`;
const VERIFY_SQL = `WITH c AS (SELECT geom FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1),
 p AS (SELECT x.id,ST_SetSRID(ST_MakePoint(x.lon,x.lat),4326) AS geom FROM jsonb_to_recordset($2::jsonb) AS x(id text,lat float8,lon float8))
 SELECT p.id FROM p CROSS JOIN c WHERE NOT ST_Covers(c.geom,p.geom)`;
// Valuta il guadagno geometrico marginale di OGNI centro rispetto ai cerchi gia' esplorati.
// La copertura e' limitata al poligono amministrativo. I centri non sono fermate.
const GAINS_SQL = `WITH c AS (SELECT geom FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1),
 remaining AS (SELECT x.id, ST_SetSRID(ST_MakePoint(x.lon,x.lat),4326) AS p FROM jsonb_to_recordset($2::jsonb) AS x(id text,lat float8,lon float8)),
 visited AS (SELECT ST_SetSRID(ST_MakePoint(x.lon,x.lat),4326) AS p FROM jsonb_to_recordset($3::jsonb) AS x(lat float8,lon float8)),
 covered AS (SELECT ST_UnaryUnion(ST_Collect(ST_Buffer(p::geography,$4::float8)::geometry)) AS geom FROM visited)
 SELECT r.id, ST_Area(ST_Difference(ST_Intersection(c.geom,ST_Buffer(r.p::geography,$4::float8)::geometry),
 COALESCE(v.geom,ST_GeomFromText('POLYGON EMPTY',4326)))::geography) AS gain_m2
 FROM remaining r CROSS JOIN c CROSS JOIN covered v ORDER BY gain_m2 DESC,r.id`;
const COVERAGE_SQL = `WITH c AS (SELECT geom FROM public.pixel_confini_comunali WHERE codice_istat_comune=$1),
 p AS (SELECT ST_SetSRID(ST_MakePoint(x.lon,x.lat),4326) AS geom FROM jsonb_to_recordset($2::jsonb) AS x(lat float8,lon float8)),
 u AS (SELECT ST_UnaryUnion(ST_Collect(ST_Buffer(geom::geography,$3::float8)::geometry)) AS geom FROM p)
 SELECT CASE WHEN u.geom IS NULL THEN 0 ELSE 100*ST_Area(ST_Intersection(c.geom,u.geom)::geography)/NULLIF(ST_Area(c.geom::geography),0) END AS pct FROM c CROSS JOIN u`;
const dist = (a,b) => {const r=Math.PI/180, x=(b.lat-a.lat)*r,y=(b.lon-a.lon)*r;
 return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(x/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(y/2)**2)));};
const round = (n,d=3) => Number(Number(n).toFixed(d));
const integer = (n,name,max) => {if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error(`${name} non valido`);};

export async function planPixelTerritorialDiscoveryV561(codiceIstat, {
 database=pool,maxGoogleCalls=48,searchRadiusMeters=1500,gridStepMeters=3000,
 targetCoveragePercent=98,maxAdditionalCenters=30,minMarginalGainM2=100000,
 minCenterDistanceMeters=500,categoryQuotas=CATEGORY_QUOTAS,
}={}) {
 const codice=String(codiceIstat);
 if(!/^\d{6}$/.test(codice))throw new Error('Codice ISTAT non valido');
 integer(maxGoogleCalls,'maxGoogleCalls',500);
 if(!Number.isFinite(searchRadiusMeters)||searchRadiusMeters<100||searchRadiusMeters>5000)throw new Error('searchRadiusMeters non valido');
 if(!Number.isFinite(gridStepMeters)||gridStepMeters<=0)throw new Error('gridStepMeters non valido');
 if(!categoryQuotas||typeof categoryQuotas!=='object'||Array.isArray(categoryQuotas))throw new Error('categoryQuotas non valido');
 const validCategories=['autobus','ferrovia','porto','aeroporto','stadio'];
 for(const [k,v] of Object.entries(categoryQuotas)) {if(!validCategories.includes(k))throw new Error(`Categoria non supportata: ${k}`);integer(v,`quota ${k}`,500);}
 const adaptive=await generatePixelAdaptiveCenters(codice,{database,searchRadiusMeters,gridStepMeters,
  targetCoveragePercent,maxAdditionalCenters,minMarginalGainM2,minCenterDistanceMeters});
 const {rows}=await database.query(BASE_SQL,[codice,gridStepMeters]);
 const base=rows.map((r,i)=>({id:`${codice}:base:${i+1}`,tipo:'base',lat:Number(r.lat),lon:Number(r.lon)}));
 const extra=adaptive.centri.map(c=>({id:c.id_virtuale,tipo:'integrativo',lat:Number(c.lat),lon:Number(c.lon)}));
 if(base.length!==adaptive.centri_base)throw new Error('Griglia base incoerente');
 const all=[...base,...extra];
 if(new Set(all.map(c=>c.id)).size!==all.length)throw new Error('ID centri duplicati');
 const {rows:outside}=await database.query(VERIFY_SQL,[codice,JSON.stringify(all)]);
 if(outside.length)throw new Error(`Centri fuori comune: ${outside.map(x=>x.id).join(', ')}`);
 const quotas=Object.fromEntries(validCategories.map(k=>[k,categoryQuotas[k]??0]));
 const reserved=Math.min(maxGoogleCalls,Object.values(quotas).reduce((a,b)=>a+b,0));
 const geoBudget=maxGoogleCalls-reserved;
 const calls=[], explored=[], remaining=[...all];
 const add=(c,category,gain=null)=>calls.push({numero:calls.length+1,centro_id:c.id,tipo_centro:c.tipo,
  lat:c.lat,lon:c.lon,categoria:category,metodo:'NEARBY',raggio_m:searchRadiusMeters,guadagno_marginale_km2:gain==null?null:round(gain/1e6,4)});
 // Fase geografica: una query trasporto per centro, selezionato per guadagno marginale reale.
 while(remaining.length && explored.length<geoBudget){
  const {rows:gains}=await database.query(GAINS_SQL,[codice,JSON.stringify(remaining),JSON.stringify(explored),searchRadiusMeters]);
  if(!gains.length)break;
  const best=gains[0], index=remaining.findIndex(c=>c.id===best.id);
  if(index<0)throw new Error('Ranking marginale incoerente');
  const c=remaining.splice(index,1)[0];
  explored.push(c);add(c,'trasporto',Number(best.gain_m2));
 }
 // Fase categorie: quote distribuite tra centri gia' esplorati; non incrementano la copertura.
 // Se nessun centro e' esplorato (budget molto piccolo), si usano i primi centri disponibili.
 const anchors=explored.length?explored:all;
 // Interleaving delle categorie per evitare che un budget ridotto sia consumato da una sola.
 const scheduled=Object.fromEntries(Object.keys(quotas).map(k=>[k,0]));
 while(calls.length<maxGoogleCalls && anchors.length){
  const possible=Object.keys(quotas).filter(k=>scheduled[k]<Math.min(quotas[k],anchors.length));
  if(!possible.length)break;
  for(const category of possible){
   if(calls.length>=maxGoogleCalls)break;
   const i=scheduled[category]++;
   const center=anchors[i%anchors.length];
   add(center,category);
  }
 }
 // Budget non utilizzato: eventuali ulteriori centri, sempre con guadagno marginale.
 while(calls.length<maxGoogleCalls && remaining.length){
  const {rows:gains}=await database.query(GAINS_SQL,[codice,JSON.stringify(remaining),JSON.stringify(explored),searchRadiusMeters]);
  const best=gains[0];if(!best)break;
  const c=remaining.splice(remaining.findIndex(x=>x.id===best.id),1)[0];
  explored.push(c);add(c,'trasporto',Number(best.gain_m2));
 }
 // La copertura comprende ogni centro con almeno una chiamata pianificata,
 // anche quando il budget e' interamente riservato alle categorie strategiche.
 const plannedCenterIds=new Set(calls.map(call=>call.centro_id));
 const coveredCenters=all.filter(center=>plannedCenterIds.has(center.id));
 const {rows:coverage}=await database.query(COVERAGE_SQL,[codice,JSON.stringify(coveredCenters),searchRadiusMeters]);
 if(coveredCenters.length>0 && (coverage.length!==1 || coverage[0]?.pct==null))
  throw new Error('Copertura geometrica non disponibile per centri pianificati');
 const categories=Object.fromEntries(['trasporto',...validCategories].map(k=>[k,calls.filter(x=>x.categoria===k).length]));
 const geoPct=round(coverage[0]?.pct??0);
 return {comune:codice,nome_comune:adaptive.nome_comune,modalita:'DRY_RUN',politica:'marginal_gain_with_category_quotas',
  centri_base:base.length,centri_integrativi:extra.length,centri_disponibili:all.length,
  centri_esplorati:explored.length,centri_non_esplorati:all.length-explored.length,
  centri_esplorati_geografici:explored.length,centri_pianificati_distinti:coveredCenters.length,
  copertura_teorica_v552_pct:adaptive.copertura_finale_percentuale,copertura_geometrica_piano_pct:geoPct,
  chiamate_google_pianificate:calls.length,max_google_calls:maxGoogleCalls,categorie:categories,
  quote_richieste:quotas,quote_rispettate:Object.fromEntries(validCategories.map(k=>[k,categories[k]>=Math.min(quotas[k],anchors.length,maxGoogleCalls)])),
  centri_fuori_comune:outside.length,motivo_arresto:calls.length>=maxGoogleCalls?'limite_chiamate':'piano_esaurito',
  piano:calls,diagnostica:{nessuna_chiamata_google:true,nessuna_scrittura:true,
   guadagno_geometrico_non_equivale_a_utilita_trasporto:true,
   centri_v552_motivo_arresto:adaptive.motivo_arresto},
  avvertenza:'Quote sperimentali, non derivate dalla domanda. Copertura geometrica, non fermate effettive. Nessuna chiamata Google.'};
}
