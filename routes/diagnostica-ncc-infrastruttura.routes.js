// TURENTU NCC - PRE-FLIGHT INFRASTRUTTURA SU RENDER
// GET /api/admin/diagnostica-ncc-infrastruttura
// Richiede x-diagnostic-token; non scrive su DB/Redis/Stripe.
// Rimuovere la route dopo il collaudo.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import ngeohash from 'ngeohash';
import polyline from '@mapbox/polyline';
import * as turf from '@turf/turf';
import { CacheStore } from '../services/search/search.cache.js';
import { pool } from '../db/db.js';
import { redisClient } from '../redis.js';

const router = Router();
const TIMEOUT_MS = 8000;
function authorized(req) {
  const expected = process.env.DIAGNOSTIC_TOKEN;
  const received = req.get('x-diagnostic-token');
  if (!expected || !received || expected.length < 24) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function withTimeout(promise, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}: timeout ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}
function safeError(err) {
  // Non restituire messaggi grezzi: potrebbero contenere URL, host o credenziali.
  return err?.code && /^[A-Z0-9_]+$/.test(err.code) ? err.code : 'CONTROLLO_FALLITO';
}
// Diagnostica NCC specifica: nessuna scrittura su Redis o PostgreSQL.
// Coordinate opzionali nella query: origin_lat, origin_lon, dest_lat, dest_lon.
function parseCoordinates(query) {
  const keys = ['origin_lat', 'origin_lon', 'dest_lat', 'dest_lon'];
  const supplied = keys.filter(k => query[k] !== undefined);
  if (supplied.length === 0) return null;
  if (supplied.length !== 4) throw new Error('COORDINATE_INCOMPLETE');
  const values = Object.fromEntries(keys.map(k => [k, Number(query[k])]));
  if (keys.some(k => typeof query[k] !== 'string' || query[k].trim() === '' || !Number.isFinite(values[k]))) {
    throw new Error('COORDINATE_NON_VALIDE');
  }
  if (Math.abs(values.origin_lat) > 90 || Math.abs(values.dest_lat) > 90 ||
      Math.abs(values.origin_lon) > 180 || Math.abs(values.dest_lon) > 180) {
    throw new Error('COORDINATE_NON_VALIDE');
  }
  return values;
}

async function diagnosticGeoIndex(coords) {
  const trattaId = 15;
  const corsaId = 925;
  const { rows } = await withTimeout(pool.query(`
    SELECT id, corsa_id, direzione, stato_temporale, percorso_polyline
    FROM public.corse_tratte WHERE id = $1 AND corsa_id = $2
  `, [trattaId, corsaId]), 'Tratta NCC');
  const db = rows[0] ?? null;
  const cached = CacheStore.tratteCache.get(trattaId);
  const cachedCorsa = CacheStore.corseCache.get(corsaId);
  const raw = await withTimeout(redisClient.get(`tratta:hashes:${trattaId}`), 'Indice Redis');
  let indexedHashes = [];
  let indexJsonValid = true;
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed) || parsed.some(h => typeof h !== 'string')) indexJsonValid = false;
    else indexedHashes = [...new Set(parsed)];
  } catch { indexJsonValid = false; }
  const membership = await withTimeout(Promise.all(indexedHashes.map(async h =>
    redisClient.sIsMember(`tratta:in_area:${h}`, String(trattaId))
  )), 'Membership Redis');
  const result = {
    corsa_id: corsaId,
    tratta_id: trattaId,
    database: { presente: Boolean(db), direzione: db?.direzione ?? null, stato_temporale: db?.stato_temporale ?? null },
    cache: { tratta_presente: Boolean(cached), corsa_presente: Boolean(cachedCorsa),
      punti_polyline: cached?.decodedCoords?.length ?? 0,
      corsa_prenotabile: cachedCorsa?.stato === 'prenotabile' },
    redis: { chiave_hashes_presente: raw !== null, formato_valido: indexJsonValid,
      celle_indicizzate: indexedHashes.length,
      riferimenti_presenti: membership.filter(Boolean).length,
      indice_coerente: indexJsonValid && indexedHashes.length > 0 && membership.every(Boolean) },
    ricerca: { coordinate_fornite: Boolean(coords) }
  };
  if (!coords) return result;

  const originHash = ngeohash.encode(coords.origin_lat, coords.origin_lon, 5);
  const searchHashes = [originHash, ...ngeohash.neighbors(originHash)];
  const hits = await withTimeout(Promise.all(searchHashes.map(h =>
    redisClient.sIsMember(`tratta:in_area:${h}`, String(trattaId))
  )), 'Ricerca Redis');
  result.ricerca = {
    coordinate_fornite: true,
    hash_origine: originHash,
    celle_interrogate: searchHashes,
    celle_con_tratta: searchHashes.filter((_, i) => hits[i]),
    tratta_recuperata_da_redis: hits.some(Boolean)
  };
  const encoded = cached?.percorso_polyline || db?.percorso_polyline;
  if (encoded) {
    const decoded = polyline.decode(encoded);
    if (decoded.length >= 2) {
      const line = turf.lineString(decoded.map(([lat, lon]) => [lon, lat]));
      const snap = (lat, lon) => {
        const p = turf.nearestPointOnLine(line, turf.point([lon, lat]), { units: 'kilometers' });
        return { distanza_km: Number(p.properties.dist.toFixed(4)),
          offset_metri: Number((p.properties.location * 1000).toFixed(2)),
          entro_3km: p.properties.dist <= 3 };
      };
      const origin = snap(coords.origin_lat, coords.origin_lon);
      const destination = snap(coords.dest_lat, coords.dest_lon);
      result.ricerca.snap_origine = origin;
      result.ricerca.snap_destinazione = destination;
      result.ricerca.direzione_valida = origin.offset_metri < destination.offset_metri;
      result.ricerca.tratto_almeno_500m = destination.offset_metri - origin.offset_metri >= 500;
      result.ricerca.supera_controlli_geometrici = origin.entro_3km && destination.entro_3km &&
        result.ricerca.direzione_valida && result.ricerca.tratto_almeno_500m;
      result.ricerca.diagnosi_preselezione = !result.ricerca.tratta_recuperata_da_redis && result.ricerca.supera_controlli_geometrici
        ? 'POSSIBILE_FALSO_NEGATIVO_INDICE_REDIS'
        : result.ricerca.tratta_recuperata_da_redis ? 'TRATTA_PRESENTE_IN_PRESELEZIONE' : 'TRATTA_NON_RECUPERATA';
    } else result.ricerca.errore_geometria = 'POLILINEA_TROPPO_CORTA';
  } else result.ricerca.errore_geometria = 'POLILINEA_ASSENTE';
  return result;
}

router.get('/diagnostica-ncc-infrastruttura', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!process.env.DIAGNOSTIC_TOKEN || process.env.DIAGNOSTIC_TOKEN.length < 24) {
    return res.status(404).json({ ok: false, error: 'Non disponibile' });
  }
  if (!authorized(req)) return res.status(403).json({ ok: false, error: 'Non autorizzato' });

  let coordinates;
  try { coordinates = parseCoordinates(req.query); }
  catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

  const checks = {};
  try {
    if (!redisClient) throw new Error('Redis non configurato');
    if (!redisClient.isReady) throw new Error('Redis non pronto');
    const pong = await withTimeout(redisClient.ping(), 'Redis');
    checks.redis = { ok: pong === 'PONG', ready: redisClient.isReady };
  } catch (err) {
    checks.redis = { ok: false, ready: Boolean(redisClient?.isReady), error: safeError(err) };
  }

  try {
    const result = await withTimeout(pool.query('SELECT 1 AS ok'), 'PostgreSQL');
    checks.postgresql = { ok: Number(result.rows[0]?.ok) === 1 };
  } catch (err) {
    checks.postgresql = { ok: false, error: safeError(err) };
  }

  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key.startsWith('sk_test_')) {
    checks.stripe = { ok: false, test_mode: false, error: 'CHIAVE_TEST_ASSENTE' };
  } else {
    try {
      const stripe = new Stripe(key, { timeout: TIMEOUT_MS, maxNetworkRetries: 0 });
      const account = await withTimeout(stripe.accounts.retrieve(), 'Stripe');
      checks.stripe = { ok: Boolean(account?.id), test_mode: true };
    } catch (err) {
      checks.stripe = { ok: false, test_mode: true, error: safeError(err) };
    }
  }

  let ncc_geo_index;
  try {
    if (!redisClient?.isReady) throw new Error('REDIS_NON_PRONTO');
    ncc_geo_index = await diagnosticGeoIndex(coordinates);
  } catch (err) {
    ncc_geo_index = { corsa_id: 925, tratta_id: 15, error: safeError(err) };
  }

  const ok = Object.values(checks).every(x => x.ok);
  console.log('[NCC INFRA PREFLIGHT]', { ok, redis: checks.redis.ok, postgresql: checks.postgresql.ok, stripe: checks.stripe.ok });
  return res.status(ok ? 200 : 503).json({ ok, mode: 'READ_ONLY', checks, ncc_geo_index });
});
export default router;
