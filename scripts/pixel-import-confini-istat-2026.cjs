'use strict';
/** PIXEL V5.5 — Import confini ISTAT 2026 (Bari/Lecce).
 * Usage: node scripts/pixel-import-confini-istat-2026.cjs [--import]
 * Default: read-only diagnostics; --import writes after validation.
 * Requires: npm install shapefile (and existing pg, dotenv).
 */
const path = require('node:path');
const fs = require('node:fs');
const shapefile = require('shapefile');
const { Client } = require('pg');
require('dotenv').config();
const BASE = path.resolve(process.cwd(), 'Limiti01012026', 'Com01012026', 'Com01012026_WGS84');
const TARGETS = new Map([['072006','Bari'],['075035','Lecce']]);
const WRITE = process.argv.includes('--import');
const sourceCode = feature => {
  const p = feature.properties || {};
  const key = Object.keys(p).find(k => k.toUpperCase() === 'PRO_COM_T');
  if (key) return String(p[key]).trim().padStart(6,'0');
  const alternative = Object.keys(p).find(k => k.toUpperCase() === 'PRO_COM');
  if (alternative) return String(p[alternative]).trim().padStart(6,'0');
  return null;
};
const getName = f => {
  const p=f.properties||{};
  const k=Object.keys(p).find(k=>k.toUpperCase()==='COMUNE');
  return k ? String(p[k]).trim() : null;
};
async function main() {
  for (const ext of ['.shp','.shx','.dbf','.prj']) if (!fs.existsSync(BASE+ext)) throw Error('File mancante: '+BASE+ext);
  const prj=fs.readFileSync(BASE+'.prj','utf8');
  if (!/UTM_Zone_32N/i.test(prj) || !/WGS_1984/i.test(prj)) throw Error('CRS inatteso: verificare manualmente EPSG sorgente');
  const reader=await shapefile.open(BASE+'.shp',BASE+'.dbf');
  const found=new Map(); let scanned=0; let sample=null;
  while (true) {
    const {done,value}=await reader.read(); if(done) break;
    scanned++;
    if (!sample) sample=Object.keys(value.properties||{});
    const code=sourceCode(value);
    if (TARGETS.has(code)) {
      if (found.has(code)) throw Error('Codice ISTAT duplicato nel file: '+code);
      if (!['Polygon','MultiPolygon'].includes(value.geometry?.type)) throw Error('Geometria inattesa per '+code);
      found.set(code,value);
    }
  }
  console.log('Modalità:',WRITE?'IMPORTAZIONE':'DIAGNOSTICA SOLA LETTURA');
  console.log('Record shapefile:',scanned,'Campi DBF:',sample);
  for (const [code,name] of TARGETS) {
    const f=found.get(code);
    if(!f) throw Error('Comune non trovato: '+code+' — verificare i campi ISTAT dello shapefile');
    console.log('Comune:',code,'nome ISTAT:',getName(f),'geometria:',f.geometry.type);
    if (getName(f)?.toLocaleLowerCase('it-IT')!==name.toLocaleLowerCase('it-IT')) throw Error('Nome comune inatteso per '+code);
  }
  const client=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?.includes('localhost')?false:{rejectUnauthorized:false}});
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL assente in ambiente/.env. Nessuna scrittura eseguita.');
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const [code,name] of TARGETS) {
      const geojson=JSON.stringify(found.get(code).geometry);
      const sql=`WITH g AS (
        SELECT ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1),32632),4326)) AS geom
      ) SELECT ST_IsValid(geom) AS valid, ST_IsEmpty(geom) AS empty,
          ST_SRID(geom) AS srid, ST_GeometryType(geom) AS type,
          ST_Area(geom::geography)/1000000 AS area_km2,
          ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lon,
          ST_AsGeoJSON(geom) AS geom_json FROM g`;
      const {rows:[r]}=await client.query(sql,[geojson]);
      console.log(code,name,'PostGIS:',{valid:r.valid,empty:r.empty,srid:r.srid,type:r.type,area_km2:Number(r.area_km2).toFixed(2),lat:r.lat,lon:r.lon});
      if (!r.valid||r.empty||r.srid!==4326||r.type!=='ST_MultiPolygon') throw Error('Geometria non valida '+code);
      if (!(r.lat>39 && r.lat<43 && r.lon>14 && r.lon<20)) throw Error('Coordinate fuori Puglia: '+code);
      if (WRITE) {
        const result=await client.query(`INSERT INTO public.pixel_confini_comunali
          (codice_istat_comune,nome_comune,geom,fonte,anno_riferimento)
          VALUES ($1,$2,ST_SetSRID(ST_GeomFromGeoJSON($3),4326),$4,2026)
          ON CONFLICT (codice_istat_comune) DO NOTHING RETURNING codice_istat_comune`,
          [code,name,r.geom_json,'ISTAT - Limiti amministrativi 01/01/2026, non generalizzati']);
        if (result.rowCount!==1) throw Error('Confine già presente per '+code+'; import annullato senza sovrascrivere');
      }
    }
    if (WRITE) {await client.query('COMMIT');console.log('IMPORTAZIONE COMPLETATA: 2 comuni');}
    else {await client.query('ROLLBACK');console.log('DIAGNOSTICA COMPLETATA: nessuna modifica al DB');}
  } catch(e) {await client.query('ROLLBACK');throw e;}
  finally {await client.end();}
}
main().catch(e=>{console.error('ERRORE:',e.message);process.exitCode=1;});
