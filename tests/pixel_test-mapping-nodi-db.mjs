// TURENTU — Diagnostica mapping nodi PIXEL / POPBUS V2
// Eseguire da project-root: node --env-file=.env tests/pixel_test-mapping-nodi-db.mjs
// SOLO LETTURA: BEGIN READ ONLY, nessuna DDL/DML, nessun worker importato.
import { pool } from '../db/db.js';

const TABLES = ['nodi_territoriali', 'nodi_direttrice'];
const MAX_NODES = 10000;
const RADIUS_METRES = 50;
const toNum = v => v == null ? null : Number(v);
const qid = s => '"' + s.replaceAll('"', '""') + '"';

async function inspect(client, table) {
  const { rows: columns } = await client.query(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
    ORDER BY ordinal_position`, [table]);
  if (!columns.length) return {table, error:'TABELLA_NON_TROVATA_O_NON_VISIBILE'};
  const names = new Set(columns.map(c => c.column_name));
  if (!names.has('id')) return {table, columns, error:'COLONNA_ID_ASSENTE'};
  const geo = columns.find(c => c.udt_name === 'geometry' || c.udt_name === 'geography');
  const lat = ['lat','latitude','latitudine'].find(n => names.has(n));
  const lon = ['lon','lng','longitude','longitudine'].find(n => names.has(n));
  if (!geo && !(lat && lon)) return {table, columns, error:'COORDINATE_NON_IDENTIFICATE'};
  const count = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.${qid(table)}`);
  const total = Number(count.rows[0].n);
  if (total > MAX_NODES) return {table, columns, total, error:`TROPPI_NODI_MAX_${MAX_NODES}`};
  let latExpr, lonExpr;
  if (geo) {
    // Trasformazione esplicita a WGS84; geometrie vuote o SRID assente vengono escluse.
    const g = qid(geo.column_name);
    const point = `CASE WHEN ${g} IS NOT NULL AND NOT ST_IsEmpty(${g}::geometry) AND ST_SRID(${g}::geometry)>0 AND GeometryType(${g}::geometry)='POINT' THEN ST_Transform(${g}::geometry,4326) ELSE NULL END`;
    latExpr = `ST_Y(${point})`;
    lonExpr = `ST_X(${point})`;
  } else {
    latExpr = `${qid(lat)}::double precision`;
    lonExpr = `${qid(lon)}::double precision`;
  }
  const {rows} = await client.query(`SELECT id, ${latExpr} AS lat, ${lonExpr} AS lon FROM public.${qid(table)} ORDER BY id`);
  const valid = rows.filter(r => Number.isFinite(toNum(r.lat)) && Number.isFinite(toNum(r.lon)) && Math.abs(toNum(r.lat)) <= 90 && Math.abs(toNum(r.lon)) <= 180);
  return {table, columns, total, valid, invalid: rows.length - valid.length, coordinateSource: geo?.column_name ?? `${lat}/${lon}`};
}

function distance(a,b) {
  const rad=Math.PI/180, x=(Number(b.lat)-Number(a.lat))*rad, y=(Number(b.lon)-Number(a.lon))*rad;
  const h=Math.sin(x/2)**2+Math.cos(Number(a.lat)*rad)*Math.cos(Number(b.lat)*rad)*Math.sin(y/2)**2;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));
}

let client;
try {
  client=await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '20000ms'");
  const a=await inspect(client,TABLES[0]);
  const b=await inspect(client,TABLES[1]);
  for (const t of [a,b]) {
    console.log(`\n[TABELLA] ${t.table}`);
    if(t.error) {console.log('ATTENZIONE:',t.error);console.log('Colonne:',t.columns?.map(c=>`${c.column_name}:${c.udt_name}`).join(', ')??'n/d');continue;}
    console.log(JSON.stringify({totale:t.total,coordinateValide:t.valid.length,coordinateNonValide:t.invalid,origineCoordinate:t.coordinateSource}));
  }
  if (!a.valid || !b.valid) {
    console.log('\nMapping non eseguibile: controllare schema/coordinate; nessuna modifica eseguita.');
  } else {
    const matches=[], unmatched=[], ambiguous=[];
    const bById=new Map(b.valid.map(n=>[String(n.id),n]));
    let sameIdClose=0,sameIdFar=0;
    for(const n of a.valid) {
      const equalId=bById.get(String(n.id));
      if(equalId) {if(distance(n,equalId)<=RADIUS_METRES)sameIdClose++;else sameIdFar++;}
      const near=b.valid.map(m=>({id:m.id,metri:distance(n,m)}))
        .filter(m=>m.metri<=RADIUS_METRES).sort((x,y)=>x.metri-y.metri||String(x.id).localeCompare(String(y.id)));
      if(!near.length) unmatched.push(n.id);
      else if(near.length>1) ambiguous.push({pixelId:n.id,candidati:near.slice(0,5)});
      else matches.push({pixelId:n.id,popbusId:near[0].id,distanzaMetri:Math.round(near[0].metri*100)/100});
    }
    const reverse=new Map();
    for(const m of matches)reverse.set(String(m.popbusId),(reverse.get(String(m.popbusId))||0)+1);
    const duplicates=[...reverse].filter(([,n])=>n>1);
    console.log('\n[REPORT MAPPING GEOGRAFICO]');
    console.log(JSON.stringify({raggioMetri:RADIUS_METRES,nodiPixel:a.valid.length,nodiPopbus:b.valid.length,corrispondenzeUnivoche:matches.length,senzaCorrispondenza:unmatched.length,ambigui:ambiguous.length,popbusConPiuPixel:duplicates.length,idUgualiVicini:sameIdClose,idUgualiDistanti:sameIdFar},null,2));
    console.log('\n[ESEMPI CORRISPONDENZE]');console.table(matches.slice(0,30));
    console.log('[ESEMPI SENZA MATCH]');console.log(unmatched.slice(0,30));
    console.log('[ESEMPI AMBIGUI]');console.dir(ambiguous.slice(0,10),{depth:5});
    if(sameIdFar)console.log('ATTENZIONE: esistono ID identici che indicano posizioni differenti. Non usare mapping per ID.');
    if(ambiguous.length||duplicates.length)console.log('ATTENZIONE: mapping non biunivoco; necessaria verifica prima di usarlo.');
    console.log('\nNOTA: la distanza è geodetica approssimata (Haversine), NON distanza stradale; nessun mapping viene salvato.');
  }
  await client.query('ROLLBACK');
  console.log('\nFINE: transazione READ ONLY chiusa con ROLLBACK.');
} catch(e) {
  if(client)try{await client.query('ROLLBACK')}catch{}
  console.error('ERRORE DIAGNOSTICA:',e.message);
  process.exitCode=1;
} finally {
  if(client)client.release();
  await pool.end();
}
