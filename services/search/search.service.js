import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

// --- Helper ---
const getSafeDate = (val) => {
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
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
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const destLat = Number(richiesta.coordDest?.lat);
  const destLon = Number(richiesta.coordDest?.lon);
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // Calcolo distanza per soglia economica
  const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
  const distKm = info.distanzaKm || 1;

  // 1. RICERCA GEOSPAZIALE
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const [corsaResults] = await Promise.all([
    Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)))
  ]);

  const corseCandidate = [...new Set(corsaResults.flat())].map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);
  
  // 2. CORSE DI LINEA
  const { corse: corseEsistenti } = await filterDisponibilita({ ...richiesta, posti_richiesti: postiRichiesti }, corseCandidate, []);
  
  const risultatiCondivise = corseEsistenti.map(c => ({ 
      ...c, 
      id: c.id || `corsa_${c.id}`,
      tipo: 'condivisa', 
      is_slot: false 
  }));

  // 3. LOGICA POP-BUS (Gerarchica e Economica)
  let risultatiPool = [];
  const { rows: direttriciAttive } = await pool.query(`
      SELECT DISTINCT d.id, d.stato, d.veicolo_id, t.euro_km, t.prezzo_passeggero
      FROM direttrici_virtuali d
      JOIN tariffe t ON d.veicolo_id = t.veicolo_id AND t.tipo = 'standard'
      JOIN nodi_direttrice n1 ON d.id = n1.direttrice_id
      JOIN nodi_direttrice n2 ON d.id = n2.direttrice_id
      WHERE d.stato IN ('in_formazione', 'confermata')
      AND ST_DWithin(n1.posizione, ST_SetSRID(ST_MakePoint($1, $2), 4326), 2000)
      AND ST_DWithin(n2.posizione, ST_SetSRID(ST_MakePoint($3, $4), 4326), 2000)
  `, [lon, lat, destLon, destLat]);

  for (const dir of direttriciAttivate) {
      const nodi = CacheStore.nodiCache.get(dir.id) || [];
      const veicolo = CacheStore.veicoliCache.get(Number(dir.veicolo_id));
      const capacita = veicolo?.posti_totali || 8;

      const startNode = getSnapResult({coord: [lon, lat]}, nodi, 2.0);
      const endNode = getSnapResult({coord: [destLon, destLat]}, nodi, 2.0);

      if (startNode && endNode && startNode.offset_metri < endNode.offset_metri) {
          const occupati = await getOccupazioneDinamica(dir.id, startNode.offset_metri, endNode.offset_metri);
          const postiDisponibili = capacita - occupati;
          
          if (postiDisponibili >= postiRichiesti) {
              const sogliaRaggiunta = ((occupati + postiRichiesti) * dir.prezzo_passeggero) >= (distKm * dir.euro_km);
              risultatiPool.push({
                  id: `dir_${dir.id}`,
                  tipo: 'pop-bus', 
                  tipo_corsa: dir.stato, 
                  direttrice_id: dir.id,
                  posti_disponibili: postiDisponibili, 
                  is_pool: true, 
                  messaggio: sogliaRaggiunta ? "Pop Bus attivo" : "Pop Bus in formazione (attesa soglia)"
              });
          }
      }
  }

  // 4. FALLBACK (Solo se non ci sono direttrici)
  if (risultatiPool.length === 0) {
      const { rows: veicoliDisponibili } = await pool.query(`
          SELECT v.id, v.posti_totali, t.euro_km, t.prezzo_passeggero 
          FROM veicoli v 
          JOIN tariffe t ON v.id = t.veicolo_id
          WHERE v.tipo = 'pool' AND v.stato = 'disponibile' 
          AND ST_DWithin(v.posizione_attuale, ST_SetSRID(ST_MakePoint($1, $2), 4326), 5000) LIMIT 3
      `, [lon, lat]);
      
      veicoliDisponibili.forEach(v => risultatiPool.push({
          id: `nuova_proposta_${v.id}`,
          tipo: 'pop-bus', 
          tipo_corsa: 'nuova_proposta', 
          veicolo_id: v.id,
          posti_disponibili: v.posti_totali || 8, 
          is_pool: true, 
          messaggio: "Attiva un nuovo Pop-Bus"
      }));
  }

  // 5. APPLICAZIONE GERARCHIA DI VISUALIZZAZIONE
  const confermate = risultatiPool.filter(r => r.tipo_corsa === 'confermata');
  const inFormazione = risultatiPool.filter(r => r.tipo_corsa === 'in_formazione');
  
  // Logica: Se c'è una confermata, mostra solo quella. Altrimenti, prova in formazione, poi nuove proposte.
  const poolFiltrato = confermate.length > 0 ? confermate : (inFormazione.length > 0 ? inFormazione : risultatiPool);
  const risultatiFinali = [...risultatiCondivise, ...poolFiltrato];
  
  return risultatiFinali.length > 0 ? await formatResults({ ...richiesta, distanzaMetri: distKm * 1000 }, risultatiFinali) : [];
}