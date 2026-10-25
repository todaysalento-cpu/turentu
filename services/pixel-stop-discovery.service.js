// services/pixel/pixel-stop-discovery.service.js
// Google Places: uso transitorio in memoria, nessuna persistenza dei dettagli.
import { pool } from '../../db/db.js';
import { getPixelStopBudget } from './pixel-stop-budget.service.js';
import { searchGooglePlaces } from '../../utils/maps.util.js';

const SEARCHES = Object.freeze([
  { tipo: 'ferrovia', priorita: 100, query: 'stazione ferroviaria' },
  { tipo: 'autobus', priorita: 95, query: 'autostazione terminal autobus' },
  { tipo: 'aeroporto', priorita: 90, query: 'aeroporto terminal passeggeri' },
  { tipo: 'porto', priorita: 85, query: 'terminal traghetti porto passeggeri' },
  { tipo: 'stadio', priorita: 75, query: 'stadio ingresso principale' },
  { tipo: 'trasporto', priorita: 60, query: 'fermata autobus' },
]);
const PLACE_CATEGORIES = [
  { tipo: 'ferrovia', priorita: 100, types: ['train_station', 'railway_station'] },
  { tipo: 'autobus', priorita: 95, types: ['bus_station'] },
  { tipo: 'aeroporto', priorita: 90, types: ['airport', 'international_airport'] },
  { tipo: 'porto', priorita: 85, types: ['ferry_terminal'] },
  { tipo: 'stadio', priorita: 75, types: ['stadium'] },
  { tipo: 'trasporto', priorita: 60, types: ['bus_stop', 'transit_station', 'light_rail_station', 'subway_station'] },
];

export function classifyPixelPlace(place) {
  const types = new Set([...(Array.isArray(place?.types) ? place.types : []), place?.primaryType].filter(Boolean));
  if (types.has('electric_vehicle_charging_station') || types.has('gas_station')) return null;
  const match = PLACE_CATEGORIES.find(category => category.types.some(type => types.has(type)));
  return match ? { tipo: match.tipo, priorita: match.priorita } : null;
}

const DEFAULT_RADIUS_METERS = 3000;
export const PIXEL_GOOGLE_SEARCHES = SEARCHES;

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

// includeAll=true restituisce i candidati deduplicati senza taglio per nodo.
// I dettagli Google rimangono transitori: nessuna registrazione o attivazione.
export async function discoverPixelStopCandidates(nodoId, {
  apiKey = process.env.GOOGLE_MAPS_API_KEY,
  fetchImpl = globalThis.fetch,
  radiusMeters = DEFAULT_RADIUS_METERS,
  includeAll = false,
  searchCenter = null,
  searches = SEARCHES,
} = {}) {
  const { nodo, budget } = await getPixelDiscoveryContext(nodoId);
  if (budget.residue === 0 && !includeAll) return { nodo, budget, candidati: [], candidati_totali: 0, errori: [], stato: 'budget_esaurito' };
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY mancante');
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile: richiede Node.js >=18');
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 50000) throw new Error('radiusMeters non valido');
  const centro = searchCenter == null ? nodo : { lat: Number(searchCenter.lat), lon: Number(searchCenter.lon) };
  if (!validCoords(centro)) throw new Error('searchCenter non valido');
  if (!Array.isArray(searches) || searches.length > 20) throw new Error('searches non valido');
  if (!searches.every(x => x && typeof x.query === 'string' && x.query.trim())) throw new Error('query Google non valida');
  const found = new Map();
  const errori = [];
  for (const s of searches) {
    try {
      const places = await searchGooglePlaces(`${s.query} ${nodo.nome}`, centro, { apiKey, fetchImpl, radiusMeters });
      for (const p of places) {
        const loc = { lat: Number(p.location?.latitude), lon: Number(p.location?.longitude) };
        if (!p.location || !validCoords(loc) || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        const distanza_m = Math.round(pixelDistanceMeters(nodo, loc));
        if (distanza_m > radiusMeters || !p.id) continue;
        const classification = classifyPixelPlace(p);
        if (!classification) continue;
        const old = found.get(p.id);
        if (old && old.priorita >= classification.priorita) continue;
        found.set(p.id, {
          place_id: p.id, nome: p.displayName?.text ?? '',
          indirizzo: p.formattedAddress ?? '', lat: loc.lat, lon: loc.lon,
          tipo: classification.tipo, priorita: classification.priorita, distanza_m,
          google_primary_type: p.primaryType ?? null,
          google_types: Array.isArray(p.types) ? [...p.types] : [],
          google_business_status: p.businessStatus ?? null,
        });
      }
    } catch (e) { errori.push({ categoria: s.tipo, errore: e.message }); }
  }
  const ordinati = [...found.values()].sort((a, b) => b.priorita - a.priorita || a.distanza_m - b.distanza_m);
  const unici = [];
  for (const p of ordinati) {
    if (!unici.some(x => pixelDistanceMeters(x, p) < 30)) unici.push(p);
  }
  return { nodo, budget, candidati: includeAll ? unici : unici.slice(0, budget.residue),
    candidati_totali: unici.length, chiamate_google: searches.length, centro_ricerca: centro, errori, stato: errori.length ? 'parziale' : 'ok',
    avvertenza: 'Dati Google transitori in memoria; fermate NON autorizzate, NON salvate.' };
}
