import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 
import { pool } from '../../db/db.js';
import { getDurataDistanza } from '../../utils/maps.util.js'; // IMPORT AGGIUNTO

const GEOHASH_PRECISION_TRATTA = 5;

// --- Helpers ---
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

function getSnapResult(point, nodi, tolleranzaKm) {
    return nodi.reduce((prev, curr) => {
        const dist = turf.distance(point, turf.point(curr.coord), { units: 'kilometers' });
        return dist < tolleranzaKm && (prev === null || dist < prev.dist) 
            ? { ...curr, dist } : prev;
    }, null);
}

async function getOccupazioneDinamica(direttriceId, startOffset, endOffset) {
    const { rows } = await pool.query(`
        SELECT SUM(r.posti_richiesti) as carico
        FROM richieste_pop_bus r
        JOIN nodi_direttrice n_start ON r.start_node_id = n_start.id
        JOIN nodi_direttrice n_end ON r.end_node_id = n_end.id
        WHERE r.stato IN ('in_attesa', 'convertita')
        AND n_start.direttrice_id = $1
        AND n_start.offset_metri < $3 
        AND n_end.offset_metri > $2
    `, [direttriceId, startOffset, endOffset]);
    
    return Number(rows[0]?.carico || 0);
}

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca Universale | Origine: ${richiesta.coord?.lat}, ${richiesta.coord?.lon} | Dest: ${richiesta.coordDest?.lat}, ${richiesta.coordDest?.lon}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const destLat = Number(richiesta.coordDest?.lat);
  const destLon = Number(richiesta.coordDest?.lon);
  const targetDate = getSafeDate(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. RECUPERO GEOSPAZIALE
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
  
  // 2. FILTRO CORSE DI LINEA
  const impegniForti = corseCandidate.filter(c => c.tipo_corsa !== 'pop-bus' && c.stato === 'prenotabile');
  const prenotazioniBatch = corseCandidate.length > 0 ? await Promise.all(corseCandidate.map(c => redisClient.hVals(`corsa:prenotazioni:${c.id}`))) : [];

  const { corse: corseEsistenti } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  const risultatiCondivise = corseEsistenti.map(c => ({ 
      ...c, tipo: 'condivisa', is_slot: false,
      origine: c.origine || richiesta.coord, destinazione: c.destinazione || richiesta.coordDest
  }));

  // 3. LOGICA SLOT PRIVATI
  const veicoliImpegnati = new Set(impegniForti.map(c => c.veicolo_id));
  const disponibilitàMap = await getDisponibilitaBatch(slotCandidateIds, targetDate, impegniForti);
  let risultatiSlotPrivati = [];

  candidatiPool.forEach(s => {
      const dispVeicolo = disponibilitàMap.get(s.veicolo_id) || [];
      const isDisp = dispVeicolo.some(st => st.disponibile);
      const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
      if (isDisp && v && !veicoliImpegnati.has(s.veicolo_id)) {
          risultatiSlotPrivati.push({
              tipo: 'privata_slot', veicolo_id: s.veicolo_id,
              origine: richiesta.coord, destinazione: richiesta.coordDest,
              marca: v.marca || 'N/D', posti_totali: v.posti_totali, disponibile: true,
              is_slot: true, is_pool: false, messaggio: "Acquista corsa privata dedicata"
          });
      }
  });

  // 4. LOGICA POP-BUS
  let risultatiPool = [];
  const { rows: direttriciAttive } = await pool.query(`
      SELECT DISTINCT d.id, d.stato, d.veicolo_id
      FROM direttrici_virtuali d
      JOIN nodi_direttrice n1 ON d.id = n1.direttrice_id
      JOIN nodi_direttrice n2 ON d.id = n2.direttrice_id
      WHERE d.stato IN ('in_formazione', 'confermata')
      AND ST_DWithin(n1.posizione, ST_SetSRID(ST_MakePoint($1, $2), 4326), 2000)
      AND ST_DWithin(n2.posizione, ST_SetSRID(ST_MakePoint($3, $4), 4326), 2000)
  `, [lon, lat, destLon, destLat]);

  for (const dir of direttriciAttive) {
      const nodi = CacheStore.nodiCache.get(dir.id) || [];
      const veicolo = CacheStore.veicoliCache.get(Number(dir.veicolo_id));
      const startNode = getSnapResult({coord: [lon, lat]}, nodi, 2.0);
      const endNode = getSnapResult({coord: [destLon, destLat]}, nodi, 2.0);

      if (startNode && endNode && startNode.offset_metri < endNode.offset_metri) {
          const caricoAttuale = await getOccupazioneDinamica(dir.id, startNode.offset_metri, endNode.offset_metri);
          const capacita = veicolo?.posti_totali || 8;
          const postiDisponibili = capacita - caricoAttuale;

          if (postiDisponibili >= postiRichiesti) {
              risultatiPool.push({
                  tipo: 'pop-bus', tipo_corsa: dir.stato, direttrice_id: dir.id,
                  origine: richiesta.coord, destinazione: richiesta.coordDest,
                  posti_disponibili: postiDisponibili, disponibile: true,
                  is_slot: true, is_pool: true, messaggio: `Pop Bus ${dir.stato}`
              });
          }
      }
  }

  // 5. FALLBACK
  if (risultatiPool.length === 0) {
      try {
          const { rows: checkVeicoli } = await pool.query(`
              SELECT count(*) as disponibili 
              FROM veicolo 
              WHERE ST_DWithin(coord, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 30000)
          `, [lon, lat]);
          
          if (Number(checkVeicoli[0]?.disponibili) > 0) {
              risultatiPool.push({
                  tipo: 'pop-bus', tipo_corsa: 'nuova_proposta', veicolo_id: null,
                  direttrice_id: 'proposta_dinamica', origine: richiesta.coord, 
                  destinazione: richiesta.coordDest, posti_totali: 8, 
                  posti_disponibili: 8, disponibile: true, is_slot: true, 
                  is_pool: true, messaggio: "Attiva un nuovo Pop-Bus in zona"
              });
          }
      } catch (e) { console.error("⚠️ Fallback non disponibile:", e); }
  }

  // 6. CONCLUSIONE CON CALCOLO DISTANZA
  const risultatiFinali = [...risultatiCondivise, ...risultatiSlotPrivati, ...risultatiPool];
  
  if (risultatiFinali.length > 0) {
      try {
          const infoPercorso = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
          const richiestaConDistanza = { ...richiesta, distanzaMetri: infoPercorso.distanzaKm * 1000 };
          return await formatResults(richiestaConDistanza, risultatiFinali);
      } catch (err) {
          console.error("⚠️ Errore calcolo distanza nel service, procedo senza:", err);
          return await formatResults(richiesta, risultatiFinali);
      }
  }
  
  return [];
}