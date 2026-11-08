import polyline from '@mapbox/polyline';
import * as turf from '@turf/turf';

const number = value => value !== null && value !== undefined && value !== '' &&
  Number.isFinite(Number(value)) ? Number(value) : NaN;
const close = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
const distance = (a, b) => turf.length(turf.lineString([a, b]), { units: 'kilometers' });
const point = n => [number(n?.lon), number(n?.lat)];
const validPoint = p => p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const length = points => turf.length(turf.lineString(points), { units: 'kilometers' }) * 1000;

/** Reconstruct the exact offsets/indexes used by acceptance, without inserting
 * artificial connector distances between the separately encoded legs. */
function readPlan(corsa, plan) {
  if (plan?.schemaVersion !== 2 || plan.tipoItinerario !== 'FERMATE_FISICHE' ||
      Number(plan.veicoloId) !== Number(corsa.veicolo_id) ||
      !Array.isArray(plan.nodes) || plan.nodes.length < 2 ||
      !Array.isArray(plan.coordinates) || plan.coordinates.length !== plan.nodes.length ||
      !Array.isArray(plan.legs) || plan.legs.length !== plan.nodes.length - 1 ||
      !Array.isArray(plan.missioni) || plan.missioni.length < 1 || plan.missioni.length > 2 ||
      !Array.isArray(plan.evaluation?.times) || plan.evaluation.times.length !== plan.nodes.length) return null;
  const departure = number(plan.evaluation.departure), arrival = number(plan.evaluation.arrival);
  const times = plan.evaluation.times.map(number);
  if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival <= departure ||
      !close(departure, new Date(corsa.start_datetime).getTime()) ||
      !close(arrival, new Date(corsa.arrivo_datetime).getTime()) ||
      times.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t < times[i - 1])) ||
      !close(times[0], 0) || !close(departure + times.at(-1), arrival)) return null;
  const points = plan.coordinates.map(point);
  if (points.some((p, i) => !validPoint(p) ||
      !Number.isSafeInteger(Number(plan.nodes[i])) || Number(plan.nodes[i]) <= 0 ||
      Number(plan.coordinates[i].id) !== Number(plan.nodes[i]))) return null;
  const offsets = [0], indexes = [0], joined = [], legs = [];
  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i], decoded = polyline.decode(leg.polyline);
    const coordinates = decoded.map(p => [p[1], p[0]]);
    if (coordinates.length < 2 || coordinates.some(p => !validPoint(p)) ||
        distance(points[i], coordinates[0]) > 0.15 ||
        distance(points[i + 1], coordinates.at(-1)) > 0.15 ||
        !Number.isFinite(number(leg.seconds)) || number(leg.seconds) < 0 ||
        !close(times[i + 1] - times[i], number(leg.seconds) * 1000)) return null;
    const metres = length(coordinates);
    if (!Number.isFinite(metres) || metres < 0 ||
        ((leg.attesa === true || leg.roadCoincident === true) && metres > 0.01)) return null;
    joined.push(...(joined.length ? decoded.slice(1) : decoded));
    const segments = [];
    let prefix = 0;
    for (let j = 0; j < coordinates.length - 1; j++) {
      const segmentMetres = length([coordinates[j], coordinates[j + 1]]);
      if (segmentMetres > 0) segments.push({ line: turf.lineString([coordinates[j], coordinates[j + 1]]),
        offset: prefix, index: j, metres: segmentMetres });
      prefix += segmentMetres;
    }
    legs.push({ metres, segments });
    offsets.push(offsets.at(-1) + metres);
    indexes.push(joined.length - 1);
  }
  if (polyline.encode(joined) !== corsa.percorso_polyline) return null;
  let previousEnd = -1;
  for (const m of plan.missioni) {
    if (!Number.isSafeInteger(m.startIndex) || !Number.isSafeInteger(m.endIndex) ||
        m.startIndex < 0 || m.startIndex < previousEnd || m.endIndex <= m.startIndex ||
        m.endIndex >= points.length ||
        !close(number(m.partenza), departure + times[m.startIndex]) ||
        !close(number(m.arrivo), departure + times[m.endIndex]) ||
        offsets[m.endIndex] <= offsets[m.startIndex] + 1) return null;
    previousEnd = m.endIndex;
  }
  // Stops are keyed by operational node occurrence, never re-snapped globally.
  let stops = corsa.fermate_pianificate;
  if (typeof stops === 'string') stops = JSON.parse(stops);
  if (!Array.isArray(stops)) return null;
  for (const s of stops) {
    const i = s.ordine;
    if (!Number.isSafeInteger(i) || i < 0 || i >= points.length || !validPoint(point(s)) ||
        distance(points[i], point(s)) > 0.001 ||
        !close(new Date(s.orario).getTime(), departure + times[i])) return null;
  }
  return { points, legs, offsets, indexes, times, departure, missions: plan.missioni };
}

function projections(data, mission, lat, lon, maxDistanceKm) {
  const target = [lon, lat], candidates = [];
  for (let i = mission.startIndex; i <= mission.endIndex; i++) {
    candidates.push({ offset: data.offsets[i], distanceKm: distance(target, data.points[i]),
      index: data.indexes[i], endIndex: data.indexes[i], time: data.departure + data.times[i] });
    if (i === mission.endIndex || data.legs[i].metres <= 0.01) continue;
    const leg = data.legs[i];
    // Project onto individual road segments so repeated visits inside a single
    // encoded leg are retained as well as visits in separate missions.
    for (const segment of leg.segments) {
    const snapped = turf.nearestPointOnLine(segment.line, turf.point(target), { units: 'kilometers' });
    const local = segment.offset + number(snapped.properties.location) * 1000;
    const distanceKm = number(snapped.properties.dist);
    if (!Number.isFinite(local) || local < 0 || local > leg.metres + 0.01 ||
        !Number.isFinite(distanceKm)) return null;
    const offset = data.offsets[i] + Math.min(local, leg.metres);
    let time = data.departure + data.times[i] +
      (data.times[i + 1] - data.times[i]) * Math.min(local / leg.metres, 1);
    // A stop's arrival precedes its dwell time; retain that arrival at the
    // same canonical offset rather than shifting the tolerance by the dwell.
    if (local <= 0.01) {
      let first = i;
      while (first > mission.startIndex && close(data.offsets[first - 1], data.offsets[i], 0.01)) first--;
      time = data.departure + data.times[first];
    }
    candidates.push({ offset, distanceKm, index: data.indexes[i] + segment.index,
      endIndex: Math.min(data.indexes[i + 1], data.indexes[i] + segment.index + 1), time });
    }
  }
  const minimum = Math.min(...candidates.map(c => c.distanceKm));
  if (!Number.isFinite(minimum) || minimum > maxDistanceKm) return [];
  const nearest = candidates.filter(c => c.distanceKm <= minimum + 0.000001);
  const unique = [];
  for (const candidate of nearest) {
    const same = unique.find(c => close(c.offset, candidate.offset, 0.01));
    if (!same) unique.push(candidate);
    else if (candidate.time < same.time) Object.assign(same, candidate);
  }
  return unique;
}

/** Booking offsets are stored to two decimal places by acceptance. Reattach
 * rounded node endpoints to their exact canonical positions. Other endpoints
 * conservatively occupy the full rounding interval. Never modify caller rows. */
function bookingsAtPlanOffsets(bookings, offsets, indexes) {
  const endpoint = (value, start, vertex) => {
    const v = number(value);
    if (!Number.isFinite(v) || v < 0 || v > offsets.at(-1) + 0.00501) return NaN;
    // Only an explicitly recorded node vertex proves that the booking ends at
    // that node. Proximity alone cannot discard a possible small overlap.
    const index = number(vertex);
    const node = Number.isSafeInteger(index) ? indexes.indexOf(index) : -1;
    if (node >= 0 && close(offsets[node], v, 0.00501)) return offsets[node];
    return start ? Math.max(0, v - 0.005) : v + 0.005;
  };
  return bookings.map(b => ({ ...b,
    start_offset: endpoint(b.start_offset, true, b.start_index_polyline),
    end_offset: endpoint(b.end_offset, false, b.end_index_polyline) }));
}

/** Return null for invalid/unsupported physical plans. No geometric fallback:
 * stale or inconsistent metadata must not turn into a successful result. */
export function proiettaMissioniConfermate(corsa, bookings, request, config) {
  try {
    let plan = corsa.piano_attivazione;
    if (typeof plan === 'string') plan = JSON.parse(plan);
    const data = readPlan(corsa, plan);
    if (!data) return null;
    const pairs = [];
    for (const mission of data.missions) {
      const starts = projections(data, mission, request.lat, request.lon, config.maxDistanceKm);
      const ends = projections(data, mission, request.destLat, request.destLon, config.maxDistanceKm);
      if (!starts || !ends) return null;
      for (const start of starts) for (const end of ends) {
        if (end.offset <= start.offset + 1 || end.time < start.time ||
            Math.abs(start.time - request.when) > config.toleranceMinutes * 60000) continue;
        pairs.push({ start, end, boardingTime: start.time, missionOrder: mission.ordine });
      }
    }
    // Multiple distinct visits within the requested time window are ambiguous.
    // Availability must not be used to guess which visit the passenger meant.
    if (pairs.length !== 1) return null;
    return { ...pairs[0], bookings: bookingsAtPlanOffsets(bookings, data.offsets, data.indexes) };
  } catch { return null; }
}
