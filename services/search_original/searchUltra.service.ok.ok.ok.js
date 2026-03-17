import { v4 as uuidv4 } from 'uuid'; // Importiamo il pacchetto UUID
import ngeohash from 'ngeohash';
import { haversineDistance } from '../../utils/geo.util.js';
import { calcolaPrezzo } from '../../utils/pricing.util.js';
import { pool } from '../../db/db.js';
import params from '../../config/params.js';

let veicoliCache = null;
let disponibilitaCache = null;
let corseCache = null;

const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 5; // precisione geohash per filtraggio rapido

// =========================
// Caricamento cache veicoli e corse con geohash
// =========================
export async function loadCachesUltra() {
  if (veicoliCache && corseCache && disponibilitaCache) return;

  const client = await pool.connect();
  try {
    const veicoliRes = await client.query(`
      SELECT id, posti_totali, euro_km, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);

    veicoliCache = veicoliRes.rows.reduce((acc, v) => {
      acc[v.id] = {
        ...v,
        geohash: ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION)
      };
      return acc;
    }, {});

    disponibilitaCache = (await client.query(`SELECT * FROM disponibilita_veicolo`)).rows;

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

    // Aggiorna geohash corse
    corseCache.forEach(c => {
      c.geohashOrigine = ngeohash.encode(c.origine_lat, c.origine_lon, GEOHASH_PRECISION);
      c.geohashDest = ngeohash.encode(c.dest_lat, c.dest_lon, GEOHASH_PRECISION);
    });

  } finally {
    client.release();
  }
}

// =========================
// Calcolo disponibilità grezza rapida con geohash e vicini
// =========================
export function getDisponibilitaUltra(richiesta) {
  const richiestaStart = new Date(richiesta.arrivo_datetime);
  const day = richiestaStart.getDay();

  const richiestaHash = richiesta.coord
    ? ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION)
    : null;
  const richiestaHashVicini = richiestaHash
    ? ngeohash.neighbors(richiestaHash).concat(richiestaHash)
    : [];

  // FILTRO SLOT LIBERI
  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache[dv.veicolo_id];
      if (!v) return false;
      if (v.posti_totali < richiesta.posti_richiesti) return false;
      if (dv.giorni_esclusi?.includes(day)) return false;
      if (dv.inattivita?.some(p => richiestaStart >= new Date(p.start) && richiestaStart <= new Date(p.fine))) return false;

      const occupato = corseCache.some(c =>
        c.veicolo_id === dv.veicolo_id &&
        richiestaStart >= new Date(c.start_datetime) &&
        richiestaStart <= new Date(c.arrivo_datetime)
      );
      if (occupato) return false;

      // filtro geohash + distanza
      const distanzaKm = richiesta.coord
        ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord)
        : 0;
      if (richiestaHash && !richiestaHashVicini.includes(v.geohash) && distanzaKm > params.tolleranzaKm)
        return false;

      dv._distanzaKm = distanzaKm;
      return true;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  // FILTRO CORSE COMPATIBILI
  const corse = corseCache.filter(c => {
    if (richiesta.posti_richiesti > c.posti_disponibili) return false;

    // distanza tra destinazione richiesta e destinazione corsa
    if (richiesta.coordDest) {
      const distDestKm = haversineDistance(
        { lat: c.dest_lat, lon: c.dest_lon },
        richiesta.coordDest
      );
      if (distDestKm > params.tolleranzaKm) return false;
    }

    // opzionale: distanza origine
    if (richiesta.coord) {
      const distOrigKm = haversineDistance(
        { lat: c.origine_lat, lon: c.origine_lon },
        richiesta.coord
      );
      if (distOrigKm > params.tolleranzaKm) return false;
    }

    return true;
  });

  return { slots, corse };
}

// =========================
// Search ultra rapida (asincrona) con geohash ottimizzato
// =========================
// =========================
// Search ultra rapida (asincrona) con geohash ottimizzato
// =========================
export async function cercaSlotUltra(richiesta) {
  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    throw new Error('Cache non caricata. Esegui loadCachesUltra() prima.');
  }

  const { slots, corse } = getDisponibilitaUltra(richiesta);

  const topSlots = slots.slice(0, TOP_RESULTS);
  const topCorse = corse.slice(0, TOP_RESULTS);

  // Slot liberi
  const slotResults = await Promise.all(topSlots.map(async slot => {
    const v = veicoliCache[slot.veicolo_id];

    // distanza da usare per il prezzo = distanza richiesta (richiesta.km) oppure calcolata tra origine/destinazione
    const kmPrezzo = richiesta.km ?? slot._distanzaKm;

    const prezzo = await calcolaPrezzo(
      { km: kmPrezzo, tipo_corsa: 'libero', posti_prenotati: 0, primo_posto: 0 },
      v.euro_km ?? 1.0,
      1.0,
      richiesta.posti_richiesti,
      'libero'
    );

    return {
      id: uuidv4(),
      veicolo_id: slot.veicolo_id,
      coord: { lat: v.lat, lon: v.lon },
      corseCompatibili: [],
      slot_libero: true,
      distanzaKm: slot._distanzaKm,
      prezzo,
      stato: 'libero'
    };
  }));

  // Corse compatibili
  const corsaResults = await Promise.all(topCorse.map(async corsa => {
    const coord = { lat: corsa.origine_lat, lon: corsa.origine_lon };

    // distanza da usare per il prezzo = distanza della corsa dal DB
    const kmPrezzo = Number(corsa.distanza ?? richiesta.km ?? 0);

    const statoPrezzo = corsa.stato === 'prenotabile' ? 'condiviso' : corsa.stato;

    const prezzo = await calcolaPrezzo(
      { km: kmPrezzo, tipo_corsa: corsa.tipo_corsa, posti_prenotati: corsa.posti_prenotati, primo_posto: corsa.primo_posto },
      corsa.euro_km ?? 1.0,
      1.0,
      richiesta.posti_richiesti,
      statoPrezzo
    );

    return {
      id: uuidv4(),
      veicolo_id: corsa.veicolo_id,
      coord,
      corseCompatibili: [corsa],
      slot_libero: false,
      distanzaKm: 0,
      prezzo,
      stato: corsa.stato ?? 'condiviso'
    };
  }));

  return [...slotResults, ...corsaResults];
}
