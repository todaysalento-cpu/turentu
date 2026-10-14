// ============================================================
// TURENTU POPBUS V2 — PLANNER
// Routing stradale, nodi di transito e punti di fermata possibili.
// Compatibile con model.js: { nodes, legs, classe }.
//
// IMPORTANTE:
// - Non cambia la selezione dei nodi della /search.
// - I nodi attraversati NON sono automaticamente fermate.
// - Le fermate effettive dipendono dalle richieste selezionate
//   e vengono verificate da model.verificaQualitaRichieste().
// - I cicli con nodi ripetuti richiedono un modello per occorrenze
//   e NON sono ancora supportati da questo planner.
// ============================================================

import * as turf from '@turf/turf';
import polyline from 'polyline';
import { getRouteGeometry } from '../../../utils/maps.util.js';

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 1000;
const SNAP_KM = 0.03; // Comportamento esistente: nodi entro 30 metri.
const MAX_DETOUR_FACTOR = 1.15;
const MAX_DETOUR_EXTRA_METRES = 500;
const OFFSET_EPS_KM = 0.00001;
const COLOCATED_MAX_METRES = 8; // Solo casi Google OK con geometria collassata

function coordinate(n) {
  const lat = Number(n?.lat);
  const lon = Number(n?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('Coordinate nodo non valide');
  }
  return { lat, lon };
}

function samePosition(a, b) {
  return Math.abs(a.lat - b.lat) < 1e-7 &&
    Math.abs(a.lon - b.lon) < 1e-7;
}

function routeKey(a, b) {
  return `${a.lat},${a.lon}>${b.lat},${b.lon}`;
}

function airMetres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validateRoute(r, from, to) {
  const metres = Number(r?.distanzaMetri);
  const seconds = Number(r?.durata);

  if (typeof r?.polyline !== 'string' || !r.polyline ||
      !Number.isFinite(metres) || metres < 0 ||
      !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('Routing stradale incompleto');
  }

  let decoded;
  try {
    decoded = polyline.decode(r.polyline);
  } catch {
    throw new Error('Polyline stradale non valida');
  }

  // Una polyline di un solo punto è ammessa esclusivamente
  // nel caso di coincidenza stradale restituita dal routing.
  if (!Array.isArray(decoded) || decoded.length < 1 ||
      decoded.some(p => !Array.isArray(p) || p.length < 2 ||
        !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1])) ||
        Number(p[0]) < -90 || Number(p[0]) > 90 ||
        Number(p[1]) < -180 || Number(p[1]) > 180)) {
    throw new Error('Geometria stradale incompleta');
  }

  if (metres === 0 && seconds === 0) {
    const collapsed = decoded.every(p =>
      Math.abs(p[0] - decoded[0][0]) < 1e-7 &&
      Math.abs(p[1] - decoded[0][1]) < 1e-7
    );
    if (collapsed && airMetres(from, to) <= COLOCATED_MAX_METRES) {
      return {
        metres: 0,
        seconds: 0,
        polyline: r.polyline,
        roadCoincident: true
      };
    }
    throw new Error('Coincidenza stradale non verificata');
  }

  if (metres > 0 && seconds > 0 && decoded.length >= 2) {
    return { metres, seconds, polyline: r.polyline, roadCoincident: false };
  }

  throw new Error('Routing stradale incompleto');
}

export async function leg(a, b) {
  const from = coordinate(a);
  const to = coordinate(b);
  // Il planner richiede tratte con durata e distanza positive.
  // Per un movimento a distanza zero il chiamante deve gestire
  // esplicitamente la sosta o evitare il segmento duplicato.
  if (samePosition(from, to)) throw new Error('Segmento stradale a distanza zero');
  const k = routeKey(from, to);
  const saved = cache.get(k);
  if (saved && Date.now() - saved.at < CACHE_TTL_MS) return saved.value;
  if (saved) cache.delete(k);

  const value = validateRoute(await getRouteGeometry(from, to), from, to);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(k, { at: Date.now(), value });
  return value;
}

function mergePolyline(legs) {
  const coords = [];
  for (const l of legs) {
    const points = polyline.decode(l.polyline);
    for (const p of points) {
      const point = [Number(p[1]), Number(p[0])];
      const last = coords.at(-1);
      if (!last || Math.abs(last[0] - point[0]) > 1e-10 ||
          Math.abs(last[1] - point[1]) > 1e-10) {
        coords.push(point);
      }
    }
  }
  if (coords.length < 2) throw new Error('Geometria percorso insufficiente');
  return turf.lineString(coords);
}

function uniqueNodes(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const id = Number(n?.id);
    if (!Number.isSafeInteger(id)) throw new Error('ID nodo non valido');
    if (map.has(id)) throw new Error(`Nodo duplicato nel catalogo: ${id}`);
    map.set(id, { ...n, ...coordinate(n), id });
  }
  return map;
}

function mandatoryOrder(mandatory, offsets, map, base) {
  let previous = -Infinity;
  for (const id of mandatory) {
    const offset = offsets.get(id);
    if (!Number.isFinite(offset)) throw new Error('Proiezione nodo obbligatorio non valida');
    if (offset <= previous + OFFSET_EPS_KM) {
      const idx = mandatory.indexOf(id);
      const prevId = mandatory[idx - 1];
      const connector = base[idx - 1];
      if (!(idx > 0 && connector?.roadCoincident === true &&
            airMetres(map.get(prevId), map.get(id)) <= COLOCATED_MAX_METRES &&
            offset + OFFSET_EPS_KM >= previous)) {
        throw new Error('Ordine nodi obbligatori incompatibile con il routing');
      }
    }
    previous = Math.max(previous, offset);
  }
}

// Pianifica un itinerario candidato attraverso i suoi nodi obbligatori.
// I nodi del catalogo vicini alla geometria vengono mantenuti come
// opportunità di aggregazione, NON come soste obbligatorie.
// La compatibilità delle fermate commerciali dipende dalle richieste
// effettivamente selezionate e viene controllata dal model.
export async function pianifica(c, nodes) {
  if (!Array.isArray(c?.nodes) || c.nodes.length < 2 || !Array.isArray(nodes)) {
    throw new Error('Candidata o catalogo nodi non valido');
  }
  const mandatory = c.nodes.map(Number);
  if (mandatory.some(id => !Number.isSafeInteger(id))) {
    throw new Error('Nodi obbligatori non validi');
  }
  if (new Set(mandatory).size !== mandatory.length) {
    throw new Error('Nodi ripetuti non supportati: servono occorrenze distinte');
  }
  const map = uniqueNodes(nodes);
  for (const id of mandatory) {
    if (!map.has(id)) throw new Error(`Nodo obbligatorio assente: ${id}`);
  }

  // 1. Geometria stradale di riferimento della candidata.
  const base = [];
  for (let i = 0; i < mandatory.length - 1; i++) {
    base.push(await leg(map.get(mandatory[i]), map.get(mandatory[i + 1])));
  }
  if (base.every(l => l.roadCoincident)) {
    throw new Error('Itinerario con sola percorrenza zero non supportato');
  }
  const line = mergePolyline(base);
  const lengthKm = turf.length(line, { units: 'kilometers' });
  if (!Number.isFinite(lengthKm) || lengthKm <= 0) {
    throw new Error('Lunghezza geometria non valida');
  }

  // 2. Proiezione dei nodi sul percorso; gli obbligatori sono sempre
  //    presenti, gli altri solo se sufficientemente vicini.
  const required = new Set(mandatory);
  const offsets = new Map();
  const snapped = [];
  for (const n of map.values()) {
    const projection = turf.nearestPointOnLine(
      line, turf.point([n.lon, n.lat]), { units: 'kilometers' }
    );
    const distanceKm = Number(projection?.properties?.dist);
    const offsetKm = Number(projection?.properties?.location);
    if (!Number.isFinite(distanceKm) || !Number.isFinite(offsetKm)) continue;
    if (!required.has(n.id) && distanceKm > SNAP_KM) continue;
    // I nodi facoltativi proiettati sugli estremi possono invertire
    // gli estremi effettivi o creare segmenti a lunghezza zero.
    if (!required.has(n.id) &&
        (offsetKm <= OFFSET_EPS_KM || offsetKm >= lengthKm - OFFSET_EPS_KM)) continue;
    offsets.set(n.id, offsetKm);
    snapped.push({ id: n.id, offsetKm, distanceKm });
  }
  for (const id of mandatory) {
    if (!offsets.has(id)) throw new Error(`Proiezione nodo obbligatorio fallita: ${id}`);
  }
  mandatoryOrder(mandatory, offsets, map, base);

  // Conserva la posizione relativa dei nodi obbligatori in caso di
  // proiezioni coincidenti, evitando ordinamenti arbitrari per ID.
  const requiredOrder = new Map(mandatory.map((id, i) => [id, i]));
  snapped.sort((a, b) =>
    (Math.abs(a.offsetKm - b.offsetKm) <= OFFSET_EPS_KM &&
     required.has(a.id) && required.has(b.id)
      ? (requiredOrder.get(a.id) - requiredOrder.get(b.id))
      : a.offsetKm - b.offsetKm) ||
    (required.has(a.id) ? 0 : 1) - (required.has(b.id) ? 0 : 1) ||
    (requiredOrder.get(a.id) ?? Infinity) - (requiredOrder.get(b.id) ?? Infinity) ||
    a.id - b.id
  );

  // 3. Esclude nodi facoltativi troppo vicini a una proiezione già
  //    inserita. Non altera i nodi obbligatori.
  const filtered = [];
  for (const point of snapped) {
    if (required.has(point.id)) {
      filtered.push(point);
      continue;
    }
    if (filtered.some(x => Math.abs(x.offsetKm - point.offsetKm) <= OFFSET_EPS_KM)) continue;
    filtered.push(point);
  }
  const ordered = filtered.map(x => x.id);
  if (ordered[0] !== mandatory[0] || ordered.at(-1) !== mandatory.at(-1)) {
    throw new Error('Estremi routing incoerenti');
  }
  let last = -1;
  for (const id of mandatory) {
    const i = ordered.indexOf(id);
    if (i <= last) throw new Error('Ordine nodi incompatibile');
    last = i;
  }

  // 4. Routing reale tra nodi consecutivi. Un nodo in questo elenco
  //    non costituisce di per sé una fermata commerciale.
  const legs = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    legs.push(await leg(map.get(ordered[i]), map.get(ordered[i + 1])));
  }
  const original = base.reduce((sum, l) => sum + l.metres, 0);
  const actual = legs.reduce((sum, l) => sum + l.metres, 0);
  if (actual > original * MAX_DETOUR_FACTOR + MAX_DETOUR_EXTRA_METRES) {
    throw new Error('Nodi intermedi introducono deviazione eccessiva');
  }

  const cumulativeMetres = [0];
  const cumulativeSeconds = [0];
  for (const l of legs) {
    cumulativeMetres.push(cumulativeMetres.at(-1) + l.metres);
    cumulativeSeconds.push(cumulativeSeconds.at(-1) + l.seconds);
  }

  return {
    nodes: ordered,
    legs,
    classe: c.classe,
    // Metadati non distruttivi: il model esistente continua a usare
    // nodes e legs. Nessun nodo facoltativo è marcato come fermata.
    mandatoryNodes: mandatory,
    transitNodes: ordered.filter(id => !required.has(id)),
    cumulativeMetres,
    cumulativeSeconds,
    originalMetres: original,
    actualMetres: actual
  };
}
