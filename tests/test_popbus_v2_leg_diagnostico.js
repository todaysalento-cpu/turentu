// ============================================================
// TURENTU POPBUS V2 — DIAGNOSTICA LEG / GOOGLE DIRECTIONS
// SHADOW: nessuna scrittura DB, nessuna attivazione.
// Esecuzione dalla root: node --env-file=.env tests/test_popbus_v2_leg_diagnostico.js
// ============================================================
import fetch from 'node-fetch';
import { getRouteGeometry } from '../utils/maps.util.js';
import { leg } from '../services/popbus/v2/planner.js';

const A = Object.freeze({ lat: 39.9052000, lon: 18.3645000 });
const B = Object.freeze({ lat: 39.9051765, lon: 18.3644653 });
const key = process.env.GOOGLE_MAPS_API_KEY;
const report = (tag, value) => console.log(`[${tag}] ${JSON.stringify(value, null, 2)}`);

function haversineMetres(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function originalGoogle(a, b, direction) {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', `${a.lat},${a.lon}`);
  url.searchParams.set('destination', `${b.lat},${b.lon}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('key', key);
  const response = await fetch(url.toString(), { timeout: 15000 });
  const body = await response.json();
  const route = body.routes?.[0];
  const legs = route?.legs?.map(x => ({
    distance_m: x.distance?.value ?? null,
    duration_s: x.duration?.value ?? null,
    start_location: x.start_location ?? null,
    end_location: x.end_location ?? null,
    steps_count: x.steps?.length ?? null,
  })) ?? [];
  report('GOOGLE_RAW_' + direction, {
    http_status: response.status,
    google_status: body.status ?? null,
    google_error: body.error_message ?? null,
    routes_count: body.routes?.length ?? 0,
    legs,
    polyline_present: typeof route?.overview_polyline?.points === 'string' && route.overview_polyline.points.length > 0,
    polyline_length: route?.overview_polyline?.points?.length ?? 0,
    warning: route?.warnings ?? [],
  });
  return { httpOk: response.ok, googleStatus: body.status, legs, polylinePresent: !!route?.overview_polyline?.points };
}

async function checkGeometry(a, b, direction) {
  try {
    const x = await getRouteGeometry(a, b);
    report('GEOMETRY_' + direction, {
      ok: true, distanzaMetri: x.distanzaMetri,
      distanzaKm: x.distanzaKm, durataSecondi: x.durata,
      polylinePresent: !!x.polyline, polylineLength: x.polyline?.length ?? 0,
    });
  } catch (err) {
    report('GEOMETRY_' + direction, { ok: false, error: err.message });
  }
}

async function checkLeg(a, b, direction) {
  try {
    const x = await leg(a, b);
    report('PLANNER_LEG_' + direction, {
      ok: true, metres: x.metres, seconds: x.seconds,
      polylinePresent: !!x.polyline, polylineLength: x.polyline?.length ?? 0,
    });
  } catch (err) {
    report('PLANNER_LEG_' + direction, { ok: false, error: err.message });
  }
}

async function main() {
  report('DIAGNOSTICA_INPUT', {
    mode: 'SHADOW_NO_DB_WRITES',
    timestamp: new Date().toISOString(),
    origine: A, destinazione: B,
    distanza_linea_aria_m: Number(haversineMetres(A, B).toFixed(3)),
    google_key_present: !!key,
    nota: 'Tre chiamate Google Directions per direzione: RAW, getRouteGeometry, planner.leg. Totale massimo sei.',
  });
  if (!key) {
    report('ERRORE_CONFIG', { error: 'GOOGLE_MAPS_API_KEY mancante in .env' });
    process.exitCode = 1;
    return;
  }
  for (const [direction, a, b] of [['A_B', A, B], ['B_A', B, A]]) {
    try { await originalGoogle(a, b, direction); }
    catch (err) { report('GOOGLE_RAW_' + direction, { ok: false, error: err.message }); }
    await checkGeometry(a, b, direction);
    await checkLeg(a, b, direction);
  }
  report('DIAGNOSTICA_FINE', {
    read_only: true,
    db_connected: false,
    db_writes: 0,
    note: 'Non interpreta 0 metri o 0 secondi come percorso valido; confrontare RAW, GEOMETRY e PLANNER_LEG.'
  });
}

main().catch(err => {
  report('DIAGNOSTICA_ERRORE', { error: err.message });
  process.exitCode = 1;
});
