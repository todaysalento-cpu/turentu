// TURENTU POPBUS V2 — Diagnostica offset obbligatori, PostgreSQL READ ONLY
// Salvare come tests/test_popbus_offset_mandatory_readonly.mjs
// Eseguire: node --env-file=.env tests\test_popbus_offset_mandatory_readonly.mjs
// Usa pool di progetto; chiamate Google Directions possono avere costi.
import * as turf from '@turf/turf';
import polyline from 'polyline';
import { pool } from '../db/db.js';
import { getRouteGeometry } from '../utils/maps.util.js';

const ids = [12, 11, 10, 4, 9, 3, 2, 8, 1, 13];
const EPS_KM = 0.00001;
const client = await pool.connect();
let nodes;
try {
  await client.query('BEGIN READ ONLY');
  const result = await client.query(`
    SELECT id, direttrice_id, ordine, offset_metri,
           ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM public.nodi_direttrice WHERE id = ANY($1::int[])
  `, [ids]);
  nodes = result.rows;
  await client.query('ROLLBACK');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
}
const map = new Map(nodes.map(n => [Number(n.id), {
  ...n, lat: Number(n.lat), lon: Number(n.lon)
}]));
for (const id of ids) {
  const n = map.get(id);
  if (!n || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) {
    throw new Error(`Nodo ${id}: assente o coordinate non valide`);
  }
}
console.log('TURENTU POPBUS V2 — OFFSET MANDATORY — READ ONLY');
console.table(ids.map(id => { const n = map.get(id); return {
  id, lat: n.lat, lon: n.lon, direttrice_id: n.direttrice_id,
  ordine: n.ordine, offset_metri: n.offset_metri
}; }));

const segments = [];
for (let i = 0; i < ids.length - 1; i++) {
  const a = map.get(ids[i]), b = map.get(ids[i + 1]);
  const route = await getRouteGeometry(a, b);
  const coords = polyline.decode(route.polyline).map(([lat, lon]) => [lon, lat]);
  if (coords.length < 2) throw new Error(`Polyline insufficiente ${a.id}->${b.id}`);
  const geometryKm = turf.length(turf.lineString(coords), { units: 'kilometers' });
  segments.push({ from: a.id, to: b.id, coords, geometryKm,
    roadKm: Number(route.distanzaMetri) / 1000 });
}
const merged = [];
for (const s of segments) for (const p of s.coords) {
  const last = merged.at(-1);
  if (!last || Math.abs(last[0] - p[0]) > 1e-10 || Math.abs(last[1] - p[1]) > 1e-10) merged.push(p);
}
const line = turf.lineString(merged);
const totalGeometryKm = turf.length(line, { units: 'kilometers' });
let expectedKm = 0, previous = -Infinity;
const rows = [];
for (let i = 0; i < ids.length; i++) {
  const id = ids[i], n = map.get(id);
  const snap = turf.nearestPointOnLine(line, turf.point([n.lon, n.lat]), { units: 'kilometers' });
  const globalKm = Number(snap.properties.location);
  const distanceKm = Number(snap.properties.dist);
  if (!Number.isFinite(globalKm) || !Number.isFinite(distanceKm)) throw new Error(`Proiezione non valida: ${id}`);
  const inversion = i > 0 && globalKm <= previous + EPS_KM;
  rows.push({ id, globalKm: +globalKm.toFixed(5), expectedKm: +expectedKm.toFixed(5),
    differenceM: +((globalKm - expectedKm) * 1000).toFixed(1),
    snapDistanceM: +(distanceKm * 1000).toFixed(1), inversion });
  previous = Math.max(previous, globalKm);
  if (i < segments.length) expectedKm += segments[i].geometryKm;
}
console.log(JSON.stringify({ event: 'ROUTE', nodes: ids,
  totalGeometryKm: +totalGeometryKm.toFixed(3),
  sumLegGeometryKm: +expectedKm.toFixed(3),
  segments: segments.map(({from,to,geometryKm,roadKm}) => ({from,to,
    geometryKm:+geometryKm.toFixed(3), roadKm:+roadKm.toFixed(3)})) }));
console.table(rows);
console.log(JSON.stringify({ event: 'SUMMARY',
  inversions: rows.filter(r => r.inversion).map(r => r.id),
  largeOffsetDiscrepancies: rows.filter(r => Math.abs(r.differenceM) > 30).map(r => r.id),
  note: 'Offset atteso = lunghezze geometriche delle singole polyline, non distanza Google. Inversioni non applicano eccezione roadCoincident del planner.' }));
console.log('FINE — nessuna scrittura DB; Google Directions può avere costi.');
await pool.end();
