// services/pixel/pixel-stop-discovery.service.js
// Google Places: uso transitorio in memoria, nessuna persistenza dei dettagli.
import { pool } from '../../db/db.js';
import { getPixelStopBudget } from './pixel-stop-budget.service.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const SEARCHES = Object.freeze([
  { tipo: 'ferrovia', priorita: 100, query: 'stazione ferroviaria' },
  { tipo: 'autobus', priorita: 95, query: 'autostazione terminal autobus' },
  { tipo: 'aeroporto', priorita: 90, query: 'aeroporto terminal passeggeri' },
  { tipo: 'porto', priorita: 85, query: 'terminal traghetti porto passeggeri' },
  { tipo: 'stadio', priorita: 75, query: 'stadio ingresso principale' },
  { tipo: 'trasporto', priorita: 60, query: 'fermata autobus' },
]);
const DEFAULT_RADIUS_METERS = 3000;

export function pixelDistanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function validCoords(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
}
export async function getPixelDiscoveryContext(nodoId) {
  const id = Number(nodoId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('nodoId non valido');
  const { rows } = await pool.query(`
    SELECT id, nome, codice_istat_comune,
           ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali WHERE id = $1 AND attivo = TRUE`, [id]);
  if (!rows.length) throw new Error(`Nodo ${id} non trovato o inattivo`);
  const nodo = rows[0];
  const budget = await getPixelStopBudget(id);
  return { nodo: { id: String(nodo.id), nome: nodo.nome,
    comune: nodo.codice_istat_comune, lat: Number(nodo.lat), lon: Number(nodo.lon) }, budget };
}
async function googleTextSearch(query, center, apiKey, fetchImpl, radiusMeters) {
  const response = await fetchImpl(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus',
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'it', maxResultCount: 10,
      locationBias: { circle: { center: { latitude: center.lat, longitude: center.lon }, radius: radiusMeters } } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 350);
    throw new Error(`Google Places HTTP ${response.status}: ${body}`);
  }
  return (await response.json()).places ?? [];
}
// includeAll=true restituisce i candidati deduplicati senza taglio per nodo;
// NON autorizza a salvare dati Google o ad attivare fermate.
export async function discoverPixelStopCandidates(nodoId, {
  apiKey = process.env.GOOGLE_MAPS_API_KEY,
  fetchImpl = globalThis.fetch,
  radiusMeters = DEFAULT_RADIUS_METERS,
  includeAll = false,
} = {}) {
  const { nodo, budget } = await getPixelDiscoveryContext(nodoId);
  if (budget.residue === 0) return { nodo, budget, candidati: [], candidati_totali: 0, errori: [], stato: 'budget_esaurito' };
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY mancante');
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile: richiede Node.js >=18');
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 50000) throw new Error('radiusMeters non valido');
  const found = new Map();
  const errori = [];
  for (const s of SEARCHES) {
    try {
      const places = await googleTextSearch(`${s.query} ${nodo.nome}`, nodo, apiKey, fetchImpl, radiusMeters);
      for (const p of places) {
        const loc = { lat: Number(p.location?.latitude), lon: Number(p.location?.longitude) };
        if (!p.location || !validCoords(loc) || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        const distanza_m = Math.round(pixelDistanceMeters(nodo, loc));
        if (distanza_m > radiusMeters || !p.id) continue;
        const old = found.get(p.id);
        if (old && old.priorita >= s.priorita) continue;
        found.set(p.id, { place_id: p.id, nome: p.displayName?.text ?? '',
          indirizzo: p.formattedAddress ?? '', lat: loc.lat, lon: loc.lon,
          tipo: s.tipo, priorita: s.priorita, distanza_m });
      }
    } catch (e) { errori.push({ categoria: s.tipo, errore: e.message }); }
  }
  const ordinati = [...found.values()].sort((a, b) => b.priorita - a.priorita || a.distanza_m - b.distanza_m);
  const unici = [];
  for (const p of ordinati) {
    if (!unici.some(x => pixelDistanceMeters(x, p) < 30)) unici.push(p);
  }
  return { nodo, budget, candidati: includeAll ? unici : unici.slice(0, budget.residue),
    candidati_totali: unici.length, errori, stato: errori.length ? 'parziale' : 'ok',
    avvertenza: 'Dati Google transitori in memoria; fermate NON autorizzate, NON salvate.' };
}
