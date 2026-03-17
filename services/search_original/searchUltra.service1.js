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
  const richiestaHash = richiesta.coord ? ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION) : null;
  const richiestaHashVicini = richiestaHash ? ngeohash.neighbors(richiestaHash).concat(richiestaHash) : [];

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
      const distanzaKm = richiesta.coord ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord) : 0;
      if (richiestaHash && !richiestaHashVicini.includes(v.geohash) && distanzaKm > params.tolleranzaKm) return false;

      dv._distanzaKm = distanzaKm;
      return true;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  // FILTRO CORSE COMPATIBILI
  const corse = corseCache.filter(c =>
    richiesta.posti_richiesti <= c.posti_disponibili &&
    (!richiesta.coord || (richiestaHashVicini.includes(c.geohashOrigine) && richiestaHashVicini.includes(c.geohashDest)))
  );

  return { slots, corse };
}

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

  // ---------------------------
  // SLOT LIBERI
  // ---------------------------
  const slotResults = topSlots.map((slot) => {
    const v = veicoliCache[slot.veicolo_id];

    // Calcolo orari
    const orario_inizio = new Date(slot.start);
    const durata_min = slot.durata_percorso_min ?? 0;
    const orario_arrivo = new Date(orario_inizio.getTime() + durata_min * 60000);

    // Prezzo (puoi usare calcolaPrezzo se vuoi valori realistici)
    const prezzo = 0;

    return {
      id: `slot-${v.id}`,
      veicolo: { id: v.id, modello: v.modello ?? "Modello non disponibile" },
      autista: v.autista ?? { id: null, nome: "Autista non assegnato" },
      origine: slot.origine ?? richiesta.origine ?? "-",
      destinazione: slot.destinazione ?? richiesta.destinazione ?? "-",
      orario_inizio: orario_inizio.toISOString(),
      orario_arrivo: orario_arrivo.toISOString(),
      durata_percorso_min: durata_min,
      distanzaKm: slot._distanzaKm ?? 0,
      prezzo,
      corseCompatibili: [],
      slot_libero: true,
      stato: "libero"
    };
  });

  // ---------------------------
  // CORSE COMPATIBILI
  // ---------------------------
  const corsaResults = topCorse.map((corsa) => {
    const v = veicoliCache[corsa.veicolo_id];

    const orario_inizio = new Date(corsa.start_datetime);
    const durata_min = corsa.durata ?? 0;
    const orario_arrivo = corsa.arrivo_datetime
      ? new Date(corsa.arrivo_datetime)
      : new Date(orario_inizio.getTime() + durata_min * 60000);

    // Prezzo: stato 'prenotabile' mappato su 'condiviso'
    const statoPrezzo = corsa.stato === 'prenotabile' ? 'condiviso' : corsa.stato;
    const prezzo = 0; // o calcolaPrezzo se vuoi valori realistici

    return {
      id: `corsa-${corsa.id}`,
      veicolo: { id: v?.id ?? null, modello: v?.modello ?? "Modello non disponibile" },
      autista: v?.autista ?? { id: null, nome: "Autista non assegnato" },
      origine: corsa.origine ?? "-",
      destinazione: corsa.destinazione ?? "-",
      orario_inizio: orario_inizio.toISOString(),
      orario_arrivo: orario_arrivo.toISOString(),
      durata_percorso_min: durata_min,
      distanzaKm: 0,
      prezzo,
      corseCompatibili: [corsa],
      slot_libero: false,
      stato: corsa.stato ?? 'condiviso'
    };
  });

  return [...slotResults, ...corsaResults];
}
