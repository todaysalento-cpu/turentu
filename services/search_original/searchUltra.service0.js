import ngeohash from 'ngeohash';
import { haversineDistance } from '../../utils/geo.util.js';
import { calcolaPrezzo } from '../../utils/pricing.util.js';
import { pool } from '../../db/db.js';
import params from '../../config/params.js';

export let veicoliCache = null;
export let disponibilitaCache = null;
export let corseCache = null;

const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 5;

// =========================
// Caricamento cache veicoli e corse
// =========================
export async function loadCachesUltra() {
  if (veicoliCache && disponibilitaCache && corseCache) return;

  const client = await pool.connect();
  try {
    // ✅ Veicoli senza autista
    const veicoliRes = await client.query(`
      SELECT v.id, v.modello, v.posti_totali, v.euro_km,
             ST_Y(v.coord::geometry) AS lat,
             ST_X(v.coord::geometry) AS lon
      FROM veicolo v
    `);

    veicoliCache = veicoliRes.rows.reduce((acc, v) => {
      acc[v.id] = {
        ...v,
        geohash: ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION),
        autista: { id: null, nome: 'Autista non assegnato' },
      };
      return acc;
    }, {});

    // ✅ Disponibilità veicoli
    disponibilitaCache = (await client.query(`SELECT * FROM disponibilita_veicolo`)).rows;

    // ✅ Corse prenotabili
    corseCache = (await client.query(`
      SELECT c.*, v.modello, v.euro_km,
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
      c.veicolo = { id: c.veicolo_id, modello: c.modello ?? 'Modello non disponibile' };
      c.autista = { id: null, nome: 'Autista non assegnato' };
    });

    console.log("✅ Cache caricata correttamente");
  } finally {
    client.release();
  }
}

// =========================
// Ottieni disponibilità slot e corse compatibili
// =========================
export function getDisponibilitaUltra(richiesta) {
  const richiestaStart = new Date(richiesta.arrivo_datetime);
  const day = richiestaStart.getDay();
  const richiestaHash = richiesta.coord ? ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION) : null;
  const richiestaHashVicini = richiestaHash ? ngeohash.neighbors(richiestaHash).concat(richiestaHash) : [];

  // Slots liberi
  const slots = disponibilitaCache.filter(dv => {
    const v = veicoliCache[dv.veicolo_id];
    if (!v) return false;
    if (v.posti_totali < richiesta.posti_richiesti) return false;
    if (dv.giorni_esclusi?.includes(day)) return false;
    if (dv.inattivita?.some(p => richiestaStart >= new Date(p.start) && richiestaStart <= new Date(p.fine))) return false;

    const occupato = corseCache.some(c =>
      c.veicolo_id === dv.veicolo_id &&
      richiestaStart >= new Date(c.start_datetime) &&
      richiestaStart <= new Date(c.arrivo_datetime || c.start_datetime)
    );
    if (occupato) return false;

    const distanzaKm = richiesta.coord ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord) : 0;
    if (richiestaHash && !richiestaHashVicini.includes(v.geohash) && distanzaKm > params.tolleranzaKm) return false;

    dv._distanzaKm = distanzaKm;
    return true;
  });

  // Corse compatibili
  const corse = corseCache.filter(c =>
    richiesta.posti_richiesti <= (c.posti_disponibili ?? 0) &&
    (!richiesta.coord || (richiestaHashVicini.includes(c.geohashOrigine) && richiestaHashVicini.includes(c.geohashDest)))
  );

  return { slots, corse };
}

// =========================
// Cerca slot e corse con tutti i dati già calcolati
// =========================
export async function cercaSlotUltra(richiesta) {
  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    throw new Error('Cache non caricata. Esegui loadCachesUltra() prima.');
  }

  const { slots, corse } = getDisponibilitaUltra(richiesta);

  const topSlots = slots.slice(0, TOP_RESULTS);
  const topCorse = corse.slice(0, TOP_RESULTS);

  // Mappa slots liberi
  const slotResults = await Promise.all(topSlots.map(async slot => {
    const v = veicoliCache[slot.veicolo_id];
    const durata_min = slot.durata_percorso_min ?? 0;
    const orario_inizio = new Date(richiesta.arrivo_datetime);
    const orario_arrivo = new Date(orario_inizio.getTime() + durata_min * 60000);

    const prezzo = await calcolaPrezzo(
      { km: richiesta.km, tipo_corsa: 'libero', posti_prenotati: 0, primo_posto: 0 },
      v?.euro_km ?? 1.0,
      1.0,
      richiesta.posti_richiesti,
      'libero'
    );

    return {
      id: `slot-${v?.id ?? 'unknown'}`,
      slot_libero: true,
      origine: richiesta.origine ?? `${richiesta.coord?.lat},${richiesta.coord?.lon}` ?? '-',
      destinazione: richiesta.destinazione ?? '-',
      orario_inizio: orario_inizio.toISOString(),
      orario_arrivo: orario_arrivo.toISOString(),
      durata_percorso_min: durata_min,
      distanzaKm: slot._distanzaKm ?? 0,
      prezzo,
      veicolo: {
        id: v?.id ?? null,
        modello: v?.modello ?? 'Modello non disponibile'
      },
      autista: v?.autista ?? { id: null, nome: 'Autista non assegnato' },
      corseCompatibili: []
    };
  }));

  // Mappa corse pianificate
  const corsaResults = await Promise.all(topCorse.map(async c => {
    const durata_min = c.durata ?? 0;
    const orario_inizio = new Date(c.start_datetime);
    const orario_arrivo = c.arrivo_datetime
      ? new Date(c.arrivo_datetime)
      : new Date(orario_inizio.getTime() + durata_min * 60000);

    const prezzo = await calcolaPrezzo(
      { km: richiesta.km, tipo_corsa: c.tipo_corsa, posti_prenotati: c.posti_prenotati, primo_posto: c.primo_posto },
      c.euro_km ?? 1.0,
      1.0,
      richiesta.posti_richiesti,
      c.stato
    );

    return {
      id: `corsa-${c.id}`,
      slot_libero: false,
      origine: c.origine ?? `${c.origine_lat},${c.origine_lon}` ?? '-',
      destinazione: c.destinazione ?? `${c.dest_lat},${c.dest_lon}` ?? '-',
      orario_inizio: orario_inizio.toISOString(),
      orario_arrivo: orario_arrivo.toISOString(),
      durata_percorso_min: durata_min,
      distanzaKm: 0,
      prezzo,
      veicolo: c.veicolo || { id: null, modello: 'Modello non disponibile' },
      autista: c.autista || { id: null, nome: 'Autista non assegnato' },
      corseCompatibili: [c]
    };
  }));

  return [...slotResults, ...corsaResults];
}
