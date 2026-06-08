import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 
import { pool } from '../../db/db.js';

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
    const res = nodi.reduce((prev, curr) => {
        const dist = turf.distance(point, turf.point(curr.coord), { units: 'kilometers' });
        return dist < tolleranzaKm && (prev === null || dist < prev.dist) 
            ? { ...curr, dist } : prev;
    }, null);
    return res;
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
  console.log(`\n🔍 [DEBUG] Inizio ricerca per: ${richiesta.coord?.lat}, ${richiesta.coord?.lon}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const destLat = Number(richiesta.coordDest?.lat);
  const destLon = Number(richiesta.coordDest?.lon);
  
  // 1. RECUPERO GEOSPAZIALE
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  
  const [corsaResults, slotResults] = await Promise.all([
    Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`))),
    Promise.all(hashes.map(h => redisClient.sMembers(`slot:in_area:${h}`)))
  ]);

  const corseCandidate = [...new Set(corsaResults.flat())].map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);
  const slotCandidateIds = [...new Set(slotResults.flat())].map(Number);
  
  console.log(`🔍 [DEBUG] Corse trovate in zona: ${corseCandidate.length}, Slot trovati: ${slotCandidateIds.length}`);

  // 2. LOGICA POP-BUS
  let risultatiPool = [];
  const { rows: direttriciAttive } = await pool.query(`
      SELECT DISTINCT d.id, d.capacita_totale, d.stato 
      FROM direttrici_virtuali d
      JOIN nodi_direttrice n1 ON d.id = n1.direttrice_id
      JOIN nodi_direttrice n2 ON d.id = n2.direttrice_id
      WHERE d.stato IN ('in_formazione', 'confermata')
      AND ST_DWithin(n1.posizione, ST_SetSRID(ST_MakePoint($1, $2), 4326), 2000)
      AND ST_DWithin(n2.posizione, ST_SetSRID(ST_MakePoint($3, $4), 4326), 2000)
  `, [lon, lat, destLon, destLat]);

  console.log(`🔍 [DEBUG] Direttrici attive trovate: ${direttriciAttive.length}`);

  for (const dir of direttriciAttive) {
      const nodi = CacheStore.nodiCache.get(dir.id) || [];
      const startNode = getSnapResult({coord: [lon, lat]}, nodi, 2.0);
      const endNode = getSnapResult({coord: [destLon, destLat]}, nodi, 2.0);

      console.log(`🔍 [DEBUG] Verifica direttrice ${dir.id}: startNode=${!!startNode}, endNode=${!!endNode}`);

      if (startNode && endNode && startNode.offset_metri < endNode.offset_metri) {
          const caricoAttuale = await getOccupazioneDinamica(dir.id, startNode.offset_metri, endNode.offset_metri);
          const postiDisponibili = dir.capacita_totale - caricoAttuale;
          
          console.log(`🔍 [DEBUG] Direttrice ${dir.id} | Posti: ${postiDisponibili}`);

          if (postiDisponibili >= 1) {
              risultatiPool.push({
                  tipo: 'pop-bus', tipo_corsa: dir.stato, direttrice_id: dir.id,
                  posti_disponibili: postiDisponibili, is_pool: true, messaggio: `Pop Bus ${dir.stato}`
              });
          }
      }
  }

  // 3. FALLBACK
  if (risultatiPool.length === 0) {
      console.log("🔍 [DEBUG] Nessun Pop-Bus trovato, controllo fallback...");
      try {
          const { rows: veicoliPool } = await pool.query(`
              SELECT id, capacita_totale FROM veicolo 
              WHERE tipo = 'pool' AND stato = 'disponibile' 
              AND ST_DWithin(posizione_attuale, ST_SetSRID(ST_MakePoint($1, $2), 4326), 5000) LIMIT 3
          `, [lon, lat]);
          
          console.log(`🔍 [DEBUG] Veicoli fallback trovati: ${veicoliPool.length}`);
          
          veicoliPool.forEach(v => risultatiPool.push({
              tipo: 'pop-bus', tipo_corsa: 'nuova_proposta', veicolo_id: v.id,
              is_pool: true, messaggio: "Attiva un nuovo Pop-Bus"
          }));
      } catch (e) { console.error("⚠️ Errore fallback:", e); }
  }

  // 4. CONCLUSIONE
  const risultatiFinali = [...risultatiPool]; // Aggiungi qui anche le altre categorie
  console.log(`✅ [DEBUG] Risultati finali pronti: ${risultatiFinali.length}`);
  return await formatResults(richiesta, risultatiFinali);
}