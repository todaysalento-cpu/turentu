// TURENTU PIXEL - Territorial configuration diagnostics (READ ONLY)
// OSM landuse polygons are a proxy for urban footprint, not an official boundary.
import fetch from 'node-fetch';
import * as turf from '@turf/turf';

const OVERPASS_URL = process.env.PIXEL_OVERPASS_URL || 'https://overpass.kumi.systems/api/interpreter';
const TIMEOUT_MS = 25000;
const MAX_RESPONSE_BYTES = 8_000_000;
const LANDUSE = ['residential', 'commercial', 'industrial', 'retail'];

function assertPoint(node) {
  const lat = Number(node?.lat);
  const lon = Number(node?.lon);
  if (!Number.isSafeInteger(Number(node?.id)) || Number(node.id) <= 0 ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new TypeError('Nodo PIXEL non valido');
  }
  return { id: Number(node.id), nome: String(node.nome || ''), lat, lon };
}

function polygonFromWay(element) {
  if (element.type !== 'way' || !Array.isArray(element.geometry) || element.geometry.length < 4) return null;
  const coords = element.geometry.map(p => [Number(p.lon), Number(p.lat)]);
  if (coords.some(p => !p.every(Number.isFinite))) return null;
  const a = coords[0], b = coords.at(-1);
  if (a[0] !== b[0] || a[1] !== b[1]) return null;
  try {
    const poly = turf.polygon([coords], { osm_id: element.id, landuse: element.tags?.landuse });
    if (turf.area(poly) < 1000) return null;
    return poly;
  } catch { return null; }
}

async function fetchLanduse(node, radiusMetres) {
  const query = `[out:json][timeout:20];way(around:${radiusMetres},${node.lat},${node.lon})["landuse"~"^(${LANDUSE.join('|')})$"];out geom;`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Turentu-PIXEL-territorial-diagnostic/1.0' },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new Error('Risposta Overpass troppo grande');
    const json = JSON.parse(raw);
    if (!Array.isArray(json.elements)) throw new Error('Risposta Overpass non valida');
    return json.elements;
  } finally { clearTimeout(timer); }
}

/**
 * Preliminary diagnostic. Uses closed OSM ways only, not multipolygon relations.
 * Does not union overlapping geometries: area is a gross indicator, not final footprint.
 * A search radius touching the urbanized area boundary makes the estimate incomplete.
 */
export async function diagnosticaNodoTerritoriale(input, { radiusMetres = 6000 } = {}) {
  const node = assertPoint(input);
  if (!Number.isInteger(radiusMetres) || radiusMetres < 1000 || radiusMetres > 15000) {
    throw new RangeError('radiusMetres deve essere tra 1000 e 15000');
  }
  const elements = await fetchLanduse(node, radiusMetres);
  const polygons = elements.map(polygonFromWay).filter(Boolean);
  const center = turf.point([node.lon, node.lat]);
  const searchRadiusKm = radiusMetres / 1000;
  let totalSqM = 0;
  let maxDistanceKm = 0;
  let nearSearchBoundary = false;
  for (const poly of polygons) {
    totalSqM += turf.area(poly);
    const ring = poly.geometry.coordinates[0];
    for (const coord of ring) {
      const km = turf.distance(center, turf.point(coord), { units: 'kilometers' });
      maxDistanceKm = Math.max(maxDistanceKm, km);
      if (km >= searchRadiusKm * 0.95) nearSearchBoundary = true;
    }
  }
  const warnings = [
    'Stima preliminare: le geometrie OSM landuse non sono un perimetro urbano certificato.',
    'La superficie è una somma lorda: possibili sovrapposizioni e geometrie mancanti.',
    'Le relazioni multipoligono OSM non sono elaborate in questa diagnostica.'
  ];
  if (!polygons.length) warnings.push('Nessun poligono chiuso utilizzabile trovato.');
  if (nearSearchBoundary) warnings.push('L’urbanizzazione raggiunge il bordo della ricerca: estensione incompleta.');
  return {
    nodo_id: node.id,
    nome: node.nome,
    lat: node.lat,
    lon: node.lon,
    raggio_ricerca_m: radiusMetres,
    elementi_osm: elements.length,
    poligoni_utilizzabili: polygons.length,
    superficie_lorda_km2: polygons.length ? Number((totalSqM / 1e6).toFixed(3)) : null,
    distanza_massima_vertici_m: polygons.length ? Math.round(maxDistanceKm * 1000) : null,
    copertura_potenzialmente_incompleta: nearSearchBoundary,
    configurazione_automatica_pronta: false,
    warnings
  };
}
