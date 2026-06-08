import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 
import { pool } from '../../db/db.js'; // IMPORTA IL TUO POOL DB

const GEOHASH_PRECISION_TRATTA = 5;

// --- Helper invariati ---
const getSafeDate = (val) => {
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
};

const normalizeCoords = (coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return coords;
    if (Array.isArray(coords[0]) && Math.abs(coords[0][0]) > 20) {
        return coords.map(c => [c[1], c[0]]);
    }
    return coords;
};

// Helper per lo snap sui nodi
function getSnapResult(point, nodi, tolleranzaKm) {
    return nodi.reduce((prev, curr) => {
        const dist = turf.distance(point, turf.point(curr.coord), { units: 'kilometers' });
        return dist < tolleranzaKm && (prev === null || dist < prev.dist) 
            ? { ...curr, dist } : prev;
    }, null);
}

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca Universale (Node-Aware) | Lat: ${richiesta.coord?.lat} Lon: ${richiesta.coord?.lon}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const destLat = Number(richiesta.coordDest?.lat);
  const destLon = Number(richiesta.coordDest?.lon);
  const targetDate = getSafeDate(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. RECUPERO GEOSPAZIALE (Invariato)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  
  const [corsaResults, slotResults] = await Promise.all([
    Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`))),
    Promise.all(hashes.map(h => redisClient.sMembers(`slot:in_area:${h}`)))
  ]);

  const corseCandidate = [...new Set(corsaResults.flat())].map(id => {
      const c = CacheStore.corseCache.get(Number(id));
      if (!c) return null;
      c.decodedCoords = normalizeCoords(c.decodedCoords);
      return c;
  }).filter(Boolean);

  const slotCandidateIds = [...new Set(slotResults.flat())].map(Number);
  const candidatiPool = slotCandidateIds.map(id => CacheStore.veicoloToDisponibilita.get(id)).filter(Boolean);

  // 2. FILTRO CORSE (Invariato)
  const impegniForti = corseCandidate.filter(c => c.tipo_corsa !== 'pop-bus' && c.stato === 'prenotabile');
  const prenotazioniBatch = corseCandidate.length > 0 ? await Promise.all(corseCandidate.map(c => redisClient.hVals(`corsa:prenotazioni:${c.id}`))) : [];

  const { corse: corseEsistenti } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  const risultatiCondivise = corseEsistenti.map(c => ({ 
      ...c, 
      tipo: 'condivisa', 
      is_slot: false,
      origine: c.origine || richiesta.coord,
      destinazione: c.destinazione || richiesta.coordDest
  }));

  // 3. LOGICA SLOT PRIVATI (Invariata)
  const veicoliImpegnati = new Set(impegniForti.map(c => c.veicolo_id));
  const disponibilitàMap = await getDisponibilitaBatch(slotCandidateIds, targetDate, impegniForti);
  let risultatiSlotPrivati = [];

  candidatiPool.forEach(s => {
      const dispVeicolo = disponibilitàMap.get(s.veicolo_id) || [];
      const isDisp = dispVeicolo.some(st => st.disponibile);
      const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
      const impegnato = veicoliImpegnati.has(s.veicolo_id);

      if (isDisp && v && !impegnato) {
          risultatiSlotPrivati.push({
              tipo: 'privata_slot',
              veicolo_id: s.veicolo_id,
              origine: richiesta.coord,
              destinazione: richiesta.coordDest,
              marca: v.marca || 'N/D',
              modello: v.modello || 'N/D',
              rating: Number(v.rating || 0),
              servizi: v.servizi || {},
              posti_totali: v.posti_totali,
              disponibile: true,
              is_slot: true,
              is_pool: false,
              messaggio: "Acquista corsa privata dedicata"
          });
      }
  });

  // 4. LOGICA POP-BUS (Aggiornata a Node-Based)
  let risultatiPool = [];
  const { rows: direttriciAttive } = await pool.query(`
      SELECT DISTINCT d.id, d.capacita_totale, d.posti_occupati 
      FROM direttrici_virtuali d
      JOIN nodi_direttrice n1 ON d.id = n1.direttrice_id
      JOIN nodi_direttrice n2 ON d.id = n2.direttrice_id
      WHERE d.stato IN ('in_formazione', 'confermata')
      AND ST_DWithin(n1.posizione, ST_SetSRID(ST_MakePoint($1, $2), 4326), 2000)
      AND ST_DWithin(n2.posizione, ST_SetSRID(ST_MakePoint($3, $4), 4326), 2000)
  `, [lon, lat, destLon, destLat]);

  for (const dir of direttriciAttive) {
      const nodi = CacheStore.nodiCache.get(dir.id) || [];
      const startNode = getSnapResult({coord: [lon, lat]}, nodi, 2.0);
      const endNode = getSnapResult({coord: [destLon, destLat]}, nodi, 2.0);

      if (startNode && endNode && startNode.offset_metri < endNode.offset_metri) {
          risultatiPool.push({
              tipo: 'pop-bus',
              tipo_corsa: 'pop-bus',
              direttrice_id: dir.id,
              origine: richiesta.coord,
              destinazione: richiesta.coordDest,
              startOffset: startNode.offset_metri,
              endOffset: endNode.offset_metri,
              posti_totali: dir.capacita_totale,
              posti_disponibili: dir.capacita_totale - dir.posti_occupati,
              disponibile: true,
              is_slot: true,
              is_pool: true,
              messaggio: "Pop Bus: Servizio condiviso disponibile per questa tratta"
          });
      }
  }

  // 5. CONCLUSIONE (Invariata)
  const risultatiFinali = [...risultatiCondivise, ...risultatiSlotPrivati, ...risultatiPool];
  
  let distanzaMetri = 10000;
  if (richiesta.coord && richiesta.coordDest) {
      const from = turf.point([lon, lat]);
      const to = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
      distanzaMetri = turf.distance(from, to, { units: 'meters' });
  }

  const context = {
    ...richiesta,
    distanzaMetri: distanzaMetri,
    localitaOrigine: richiesta.localitaOrigine?.description || richiesta.localitaOrigine || "Partenza",
    localitaDestinazione: richiesta.localitaDestinazione?.description || richiesta.localitaDestinazione || "Destinazione"
  };
  
  return risultatiFinali.length > 0 
    ? await formatResults(context, risultatiFinali, risultatiCondivise)
    : [];
}