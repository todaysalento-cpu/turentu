// services/pixel/pixel-stop-hybrid-source.service.js
// Sorgente ibrida OSM + fermate Turentu. SOLA LETTURA: non modifica pixel_fermate.
// OSM © OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright
import { pool } from '../../db/db.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const RADIUS = 3000;
const TYPES = [
  ['railway', 'station', 'ferrovia', 100],
  ['amenity', 'bus_station', 'autobus', 95],
  ['aeroway', 'terminal', 'aeroporto', 90],
  ['amenity', 'ferry_terminal', 'porto', 85],
  ['highway', 'bus_stop', 'trasporto', 60],
  ['public_transport', 'platform', 'trasporto', 55],
];
function validCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
function distance(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function normalizeOsm(element) {
  const tags = element.tags ?? {};
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (!validCoords(lat, lon)) return null;
  const type = TYPES.find(([k, v]) => tags[k] === v);
  if (!type) return null;
  const [,, tipo, priorita] = type;
  const nome = String(tags.name ?? tags['name:it'] ?? `${tipo} OSM ${element.id}`).trim().slice(0, 150);
  return {
    place_id: `osm:${element.type}:${element.id}`, nome,
    indirizzo: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null,
    lat, lon, tipo, priorita, fonte: 'osm',
    riferimento_fonte: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    // Richiede politica di attribuzione ODbL e revisione del punto di salita.
    registrabile_automaticamente: false,
  };
}
export function mergePixelHybridCandidates(osm = [], interne = [], radiusMeters = RADIUS) {
  const sorted = [...interne, ...osm].filter(c => validCoords(Number(c.lat), Number(c.lon)))
    .map(c => ({ ...c, lat: Number(c.lat), lon: Number(c.lon) }))
    .sort((a, b) => (b.fonte === 'turentu') - (a.fonte === 'turentu') || (b.priorita ?? 0) - (a.priorita ?? 0));
  const out = [];
  for (const candidate of sorted) {
    if (!out.some(existing => existing.place_id === candidate.place_id || distance(existing, candidate) < 30)) {
      out.push(candidate);
    }
  }
  return out.filter(c => Number.isFinite(radiusMeters) && radiusMeters > 0);
}
export async function discoverPixelHybridStops(nodoId, {
  database = pool, fetchImpl = globalThis.fetch, radiusMeters = RADIUS,
  overpassUrl = OVERPASS_URL, includeOsm = true,
} = {}) {
  const id = Number(nodoId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('nodoId non valido');
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 10000) throw new Error('radiusMeters non valido');
  const node = await database.query(`SELECT id, nome, codice_istat_comune,
    ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali WHERE id=$1 AND attivo=TRUE`, [id]);
  if (!node.rowCount) throw new Error('Nodo inesistente o inattivo');
  const nodo = { ...node.rows[0], id: String(node.rows[0].id), lat: Number(node.rows[0].lat), lon: Number(node.rows[0].lon) };
  const saved = await database.query(`SELECT f.id, f.nome, f.indirizzo,
    ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon
    FROM public.pixel_fermate f JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
    WHERE n.codice_istat_comune=$1`, [nodo.codice_istat_comune]);
  const interne = saved.rows.map(f => ({ place_id: `turentu:${f.id}`, nome: f.nome,
    indirizzo: f.indirizzo, lat: Number(f.lat), lon: Number(f.lon),
    tipo: 'turentu', priorita: 110, fonte: 'turentu', esistente_id: Number(f.id),
    registrabile_automaticamente: false,
  })).filter(c => distance(nodo, c) <= radiusMeters);
  const errori = [];
  let osm = [];
  if (includeOsm) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile');
    const filters = TYPES.map(([key, value]) => `nwr(around:${Math.round(radiusMeters)},${nodo.lat},${nodo.lon})["${key}"="${value}"];`).join('\n');
    const query = `[out:json][timeout:25];(${filters});out center tags;`;
    try {
      const response = await fetchImpl(overpassUrl, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Turentu-PIXEL/1.0' },
        body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      const data = await response.json();
      osm = (data.elements ?? []).map(normalizeOsm).filter(Boolean)
        .filter(c => distance(nodo, c) <= radiusMeters);
    } catch (error) { errori.push({ fonte: 'osm', errore: error.message }); }
  }
  const candidati = mergePixelHybridCandidates(osm, interne, radiusMeters);
  return { nodo, radiusMeters, candidati, candidati_totali: candidati.length,
    fonti: { osm: osm.length, turentu: interne.length }, errori,
    stato: errori.length ? 'parziale' : 'ok',
    avvertenza: 'Sola lettura. I dati OSM sono soggetti a ODbL e attribuzione; nessuna attivazione automatica.' };
}
