/**
 * Turentu — ricerca read-only di corse POPBUS confermate.
 *
 * Nessuna scrittura DB. Non modifica PIXEL, POPBUS V2, NCC o il Booking.
 * Richiede: npm package @mapbox/polyline (gia usato da acceptance.js),
 *            @turf/turf (gia usato da acceptance.js).
 *
 * Il caller passa pool e richiesta normalizzata:
 * {lat, lon, destLat, destLon, start_datetime, posti_richiesti}.
 */
import polyline from '@mapbox/polyline';
import * as turf from '@turf/turf';

const DEFAULTS = Object.freeze({
  maxCandidates: 100,
  maxDistanceKm: 1,
  toleranceMinutes: 30,
});

function validNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function numeric(value) {
  return validNumber(value) ? Number(value) : NaN;
}

function parseRequest(r) {
  const lat = numeric(r?.lat ?? r?.coord?.lat);
  const lon = numeric(r?.lon ?? r?.coord?.lon);
  const destLat = numeric(r?.destLat ?? r?.coordDest?.lat);
  const destLon = numeric(r?.destLon ?? r?.coordDest?.lon);
  const posti = numeric(r?.posti_richiesti ?? r?.postiRichiesti);
  const when = new Date(r?.start_datetime).getTime();
  if (![lat, lon, destLat, destLon, when].every(Number.isFinite) ||
      Math.abs(lat) > 90 || Math.abs(destLat) > 90 ||
      Math.abs(lon) > 180 || Math.abs(destLon) > 180 ||
      !Number.isInteger(posti) || posti < 1) {
    throw new Error('POPBUS_SEARCH_INVALID_REQUEST');
  }
  return { lat, lon, destLat, destLon, posti, when };
}

function lineFromPolyline(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  const points = polyline.decode(encoded);
  if (!Array.isArray(points) || points.length < 2) return null;
  const coordinates = points.map(p => [Number(p[1]), Number(p[0])]);
  if (coordinates.some(p => !p.every(Number.isFinite))) return null;
  return turf.lineString(coordinates);
}

function snap(line, lat, lon) {
  const snapped = turf.nearestPointOnLine(line, turf.point([lon, lat]), { units: 'kilometers' });
  return {
    offset: numeric(snapped.properties.location) * 1000,
    distanceKm: numeric(snapped.properties.dist),
    index: numeric(snapped.properties.index),
    point: snapped.geometry.coordinates,
  };
}

/** Peak on a half-open interval [start, end); endpoints at the same offset
 * are processed with alightings before boardings. */
export function piccoOccupazione(prenotazioni, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const events = [];
  for (const p of prenotazioni) {
    const a = numeric(p.start_offset);
    const b = numeric(p.end_offset);
    const posti = numeric(p.posti_richiesti);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a ||
        !Number.isInteger(posti) || posti <= 0) return null;
    const left = Math.max(a, start);
    const right = Math.min(b, end);
    if (left < right) {
      events.push({ at: left, delta: posti }, { at: right, delta: -posti });
    }
  }
  events.sort((x, y) => x.at - y.at || x.delta - y.delta);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

/**
 * Conservative time check: only accept when boarding time is bounded by
 * timestamped planned stops (or by departure/arrival at route endpoints).
 * Stop.order indexes the plan nodes, NOT necessarily polyline vertices;
 * therefore locate stop coordinates on the encoded route instead.
 */
export function estimateBoardingTime(corsa, line, startOffset) {
  const lengthM = turf.length(line, { units: 'kilometers' }) * 1000;
  const anchors = [];
  const first = new Date(corsa.start_datetime).getTime();
  const last = new Date(corsa.arrivo_datetime).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
  anchors.push({ offset: 0, time: first });
  anchors.push({ offset: lengthM, time: last });
  let stops = corsa.fermate_pianificate;
  if (typeof stops === 'string') {
    try { stops = JSON.parse(stops); } catch { return null; }
  }
  if (!Array.isArray(stops)) return null;
  for (const stop of stops) {
    const lat = numeric(stop.lat);
    const lon = numeric(stop.lon);
    const time = new Date(stop.orario).getTime();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(time)) return null;
    const s = snap(line, lat, lon);
    if (!Number.isFinite(s.offset) || s.distanceKm > 0.15) return null;
    anchors.push({ offset: s.offset, time });
  }
  anchors.sort((a, b) => a.offset - b.offset || a.time - b.time);
  // Fail closed if stop order/times are inconsistent with route progression.
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].time < anchors[i - 1].time - 1000) return null;
  }
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (startOffset < a.offset - 0.01 || startOffset > b.offset + 0.01) continue;
    if (b.offset - a.offset < 0.01) return a.time;
    const fraction = Math.max(0, Math.min(1, (startOffset - a.offset) / (b.offset - a.offset)));
    return a.time + fraction * (b.time - a.time);
  }
  return null;
}

/** Pure evaluation of a candidate; no database access. */
export function valutaPopbusAttivata(corsa, prenotazioni, richiesta, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const r = parseRequest(richiesta);
  if (corsa.stato !== 'prenotabile' || corsa.tipo_corsa !== 'riempimento' ||
      corsa.attivazione_stato !== 'confermata') return null;
  const cap = numeric(corsa.posti_totali);
  if (!Number.isInteger(cap) || cap < r.posti) return null;
  let line;
  try { line = lineFromPolyline(corsa.percorso_polyline); } catch { return null; }
  if (!line) return null;
  let start, end;
  try {
    start = snap(line, r.lat, r.lon);
    end = snap(line, r.destLat, r.destLon);
  } catch { return null; }
  if (![start.offset, end.offset, start.distanceKm, end.distanceKm].every(Number.isFinite) ||
      start.distanceKm > cfg.maxDistanceKm || end.distanceKm > cfg.maxDistanceKm ||
      end.offset <= start.offset + 1) return null;
  const peak = piccoOccupazione(prenotazioni, start.offset, end.offset);
  if (peak === null || peak + r.posti > cap) return null;
  const boardingTime = estimateBoardingTime(corsa, line, start.offset);
  if (!Number.isFinite(boardingTime) ||
      Math.abs(boardingTime - r.when) > cfg.toleranceMinutes * 60000) return null;
  // Expose snap indexes only as geometric hints. Booking needs validated
  // indices/offsets and independent transaction-time revalidation.
  return {
    id: corsa.id,
    corsa_id: corsa.id,
    attivazione_id: corsa.attivazione_id,
    tipo: 'pop-bus',
    tipo_corsa: 'riempimento',
    stato: 'prenotabile',
    is_pool: true,
    veicolo_id: corsa.veicolo_id,
    posti_totali: cap,
    posti_disponibili_tratta: cap - peak,
    posti_richiesti: r.posti,
    start_offset: start.offset,
    end_offset: end.offset,
    start_index_polyline: Math.trunc(start.index),
    end_index_polyline: Math.trunc(end.index) + 1,
    km_utente: (end.offset - start.offset) / 1000,
    partenza_effettiva: new Date(boardingTime).toISOString(),
    origine_snap_km: start.distanceKm,
    destinazione_snap_km: end.distanceKm,
    prenotabile: true,
    // No fabricated price: pricing must be supplied by the real POPBUS tariff engine.
    prezzo: null,
    prezzo_da_calcolare: true,
  };
}

/** Read-only candidate retrieval; deliberately bounded for latency. */
export async function cercaPopbusAttivate({ pool, richiesta, options = {} }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('POPBUS_SEARCH_POOL_REQUIRED');
  const r = parseRequest(richiesta);
  const cfg = { ...DEFAULTS, ...options };
  const maxCandidates = Math.max(1, Math.min(500, Math.trunc(cfg.maxCandidates)));
  const from = new Date(r.when - cfg.toleranceMinutes * 60000).toISOString();
  const to = new Date(r.when + cfg.toleranceMinutes * 60000).toISOString();
  const { rows: candidates } = await pool.query(`
    SELECT c.id, c.veicolo_id, c.start_datetime, c.arrivo_datetime,
           c.tipo_corsa, c.stato, c.posti_totali, c.percorso_polyline,
           c.fermate_pianificate, a.id AS attivazione_id,
           a.stato AS attivazione_stato
    FROM corse c
    JOIN popbus_attivazioni a ON a.corsa_id = c.id
    WHERE a.stato = 'confermata'
      AND c.tipo_corsa = 'riempimento'
      AND c.stato = 'prenotabile'
      AND c.start_datetime <= $2::timestamptz
      AND c.arrivo_datetime >= $1::timestamptz
      AND c.arrivo_datetime > NOW()
      AND c.posti_totali >= $3
    ORDER BY c.start_datetime, c.id
    LIMIT $4
  `, [from, to, r.posti, maxCandidates]);
  if (!candidates.length) return [];
  const ids = candidates.map(c => c.id);
  const { rows: bookings } = await pool.query(`
    SELECT corsa_id, start_offset, end_offset, posti_richiesti
    FROM prenotazioni WHERE corsa_id = ANY($1::int[])
  `, [ids]);
  const byRide = new Map(ids.map(id => [Number(id), []]));
  for (const b of bookings) byRide.get(Number(b.corsa_id))?.push(b);
  return candidates.map(c => valutaPopbusAttivata(
    c, byRide.get(Number(c.id)) ?? [], richiesta, cfg
  )).filter(Boolean);
}
