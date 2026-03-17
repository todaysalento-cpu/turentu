import { v4 as uuidv4 } from 'uuid';
import ngeohash from 'ngeohash';
import { haversineDistance } from '../../utils/geo.util.js';
import { calcolaPrezzo } from '../../utils/pricing.util.js';
import { pool } from '../../db/db.js';
import params from '../../config/params.js';
import { stimaDurata } from '../../utils/maps.util.js';

let veicoliCache = null;
let disponibilitaCache = null;
let corseCache = null;

const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 5;

// =========================
// Load cache
// =========================
export async function loadCachesUltra() {
  if (veicoliCache && disponibilitaCache && corseCache) return;

  const client = await pool.connect();
  try {
    const veicoliRes = await client.query(`
      SELECT id, posti_totali, euro_km,
             ST_Y(coord::geometry) AS lat,
             ST_X(coord::geometry) AS lon,
             modello, servizi
      FROM veicolo
    `);

    veicoliCache = veicoliRes.rows.reduce((acc, v) => {
      acc[v.id] = {
        ...v,
        geohash: ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION),
        servizi: v.servizi ? JSON.parse(v.servizi) : []
      };
      return acc;
    }, {});

    disponibilitaCache = (await client.query(
      `SELECT * FROM disponibilita_veicolo`
    )).rows;

    corseCache = (await client.query(`
      SELECT c.*, v.euro_km,
             ST_Y(c.origine::geometry) AS origine_lat,
             ST_X(c.origine::geometry) AS origine_lon,
             ST_Y(c.destinazione::geometry) AS dest_lat,
             ST_X(c.destinazione::geometry) AS dest_lon
      FROM corse c
      JOIN veicolo v ON v.id = c.veicolo_id
      WHERE c.stato = 'prenotabile'
    `)).rows;

    corseCache.forEach(c => {
      c.geohashOrigine = ngeohash.encode(c.origine_lat, c.origine_lon, GEOHASH_PRECISION);
      c.geohashDest = ngeohash.encode(c.dest_lat, c.dest_lon, GEOHASH_PRECISION);
    });

  } finally {
    client.release();
  }
}

// =========================
// Disponibilità ultra
// =========================
export function getDisponibilitaUltra(richiesta) {
  const richiestaStart = new Date(richiesta.arrivo_datetime);
  const day = richiestaStart.getDay();

  const richiestaHash = richiesta.coord
    ? ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION)
    : null;

  const hashVicini = richiestaHash
    ? [...ngeohash.neighbors(richiestaHash), richiestaHash]
    : [];

  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache[dv.veicolo_id];
      if (!v) return false;
      if (v.posti_totali < richiesta.posti_richiesti) return false;
      if (dv.giorni_esclusi?.includes(day)) return false;

      const occupato = corseCache.some(c =>
        c.veicolo_id === dv.veicolo_id &&
        richiestaStart >= new Date(c.start_datetime) &&
        richiestaStart <= new Date(c.arrivo_datetime)
      );
      if (occupato) return false;

      const distanzaKm = richiesta.coord
        ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord)
        : 0;

      if (richiestaHash && !hashVicini.includes(v.geohash) && distanzaKm > params.tolleranzaKm)
        return false;

      dv._distanzaKm = distanzaKm;
      return true;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  const corse = corseCache.filter(c => {
    if (richiesta.posti_richiesti > c.posti_disponibili) return false;

    if (richiesta.coordDest) {
      const d = haversineDistance(
        { lat: c.dest_lat, lon: c.dest_lon },
        richiesta.coordDest
      );
      if (d > params.tolleranzaKm) return false;
    }

    return true;
  });

  return { slots, corse };
}

// =========================
// SEARCH ULTRA (ottimizzata)
// =========================
export async function cercaSlotUltra(richiesta) {
  if (!veicoliCache) {
    throw new Error('Cache non caricata. Chiama loadCachesUltra()');
  }

  const { slots, corse } = getDisponibilitaUltra(richiesta);
  const topSlots = slots.slice(0, TOP_RESULTS);
  const topCorse = corse.slice(0, TOP_RESULTS);

  // 🔥 UNA SOLA chiamata Maps (con cache interna)
  const durataMs = await stimaDurata(richiesta.coord, richiesta.coordDest);
  const kmTotali = haversineDistance(richiesta.coord, richiesta.coordDest);

  // =========================
  // SLOT
  // =========================
  const slotResults = await Promise.all(topSlots.map(async slot => {
    const v = veicoliCache[slot.veicolo_id];

    const oraPartenza = new Date(richiesta.arrivo_datetime);
    const oraArrivo = new Date(oraPartenza.getTime() + durataMs);

    const prezzo = await calcolaPrezzo(
      { km: kmTotali, tipo_corsa: 'libero', posti_prenotati: 0, primo_posto: 0 },
      v.euro_km ?? 1,
      1,
      richiesta.posti_richiesti,
      'libero'
    );

    return {
      tipo: 'slot',
      id: uuidv4(),
      veicolo_id: v.id,
      modello: v.modello,
      servizi: v.servizi,
      coordOrigine: richiesta.coord,
      coordDestinazione: richiesta.coordDest,
      oraPartenza,
      oraArrivo,
      durataMs,
      distanzaKm: kmTotali,
      postiTotali: v.posti_totali,
      postiRichiesti: richiesta.posti_richiesti,
      prezzo,
      euro_km: Number(v.euro_km),
      stato: 'libero',
      corseCompatibili: []
    };
  }));

  // =========================
  // CORSE
  // =========================
  const corsaResults = await Promise.all(topCorse.map(async corsa => {
    const v = veicoliCache[corsa.veicolo_id];
    const oraPartenza = new Date(corsa.start_datetime);
    const durataMs = corsa.durata ? corsa.durata * 1000 : 0;
    const oraArrivo = new Date(oraPartenza.getTime() + durataMs);

    const prezzo = await calcolaPrezzo(
      { km: Number(corsa.distanza ?? 0), tipo_corsa: corsa.tipo_corsa },
      corsa.euro_km ?? 1,
      1,
      richiesta.posti_richiesti,
      'condiviso'
    );

    return {
      tipo: 'corsa',
      id: uuidv4(),
      veicolo_id: corsa.veicolo_id,
      modello: v?.modello,
      servizi: v?.servizi,
      coordOrigine: { lat: corsa.origine_lat, lon: corsa.origine_lon },
      coordDestinazione: { lat: corsa.dest_lat, lon: corsa.dest_lon },
      oraPartenza,
      oraArrivo,
      durataMs,
      prezzo,
      stato: corsa.stato,
      corseCompatibili: [corsa]
    };
  }));

  return [...slotResults, ...corsaResults];
}
