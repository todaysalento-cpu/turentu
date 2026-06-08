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
    return nodi.reduce((prev, curr) => {
        const dist = turf.distance(point, turf.point(curr.coord), { units: 'kilometers' });
        return dist < tolleranzaKm && (prev === null || dist < prev.dist) 
            ? { ...curr, dist } : prev;
    }, null);
}

/**
 * CALCOLO DINAMICO: Verifica carico su segmento specifico [startOffset, endOffset]
 */
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
  
  console.log(`🔍 [DEBUG] Corse Candidate: ${corseCandidate.length} | Slot Candidati (ID): ${slotCandidateIds.length}`);

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
      SELECT DISTINCT d.id, d.capacita_totale, d.stato 
      FROM direttrici_virtuali d
      JOIN nodi_direttrice n1 ON d.id = n1.direttrice_id
      JOIN nodi_direttrice n2 ON d.id = n2.direttrice_id
      WHERE d.stato IN ('in_formazione', 'confermata')
      AND ST_DWithin(n1.posizione, ST_SetSRID(ST_MakePoint($1, $2), 4326), 2000)
      AND ST_DWithin(n2.posizione, ST_SetSRID(ST_MakePoint($3, $4), 4326), 2000)
  `, [lon, lat, destLon, destLat]);

  console.log(`🔍 [DEBUG] Direttrici virtuali trovate nel DB: ${direttriciAttive.length}`);

  for (const dir of direttriciAttive) {
      const nodi = CacheStore.nodiCache.get(dir.id) || [];
      const startNode = getSnapResult({coord: [lon, lat]}, nodi, 2.0);
      const endNode = getSnapResult({coord: [destLon, destLat]}, nodi, 2.0);

      if (startNode && endNode && startNode.offset_metri < endNode.offset_metri) {
          const caricoAttuale = await getOccupazioneDinamica(dir.id, startNode.offset_metri, endNode.offset_metri);
          const postiDisponibili = dir.capacita_totale - caricoAttuale;

          if (postiDisponibili >= postiRichiesti) {
              risultatiPool.push({
                  tipo: 'pop-bus', tipo_corsa: dir.stato, direttrice_id: dir.id,
                  origine: richiesta.coord, destinazione: richiesta.coordDest,
                  posti_disponibili: postiDisponibili, disponibile: true,
                  is_slot: true, is_pool: true, messaggio: `Pop Bus ${dir.stato}`
              });
          } else {
              console.log(`🔍 [DEBUG] Direttrice ${dir.id} piena o posti insufficienti.`);
          }
      } else {
          console.log(`🔍 [DEBUG] Direttrice ${dir.id} non valida (Snap fallito o ordine offset errato).`);
      }
  }

  // 5. FALLBACK: Innesco nuova direttrice
  if (risultatiPool.length === 0) {
      console.log("🔍 [DEBUG] Nessun Pop-Bus trovato, avvio fallback (nuova proposta)...");
      try {
          const { rows: veicoliPool } = await pool.query(`
              SELECT id, posti_totali FROM veicolo 
              WHERE stato = 'disponibile' 
              AND ST_DWithin(coord, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 30000) LIMIT 3
          `, [lon, lat]);
          
          veicoliPool.forEach(v => risultatiPool.push({
              tipo: 'pop-bus', tipo_corsa: 'nuova_proposta', veicolo_id: v.id,
              origine: richiesta.coord, destinazione: richiesta.coordDest,
              posti_totali: v.posti_totali, posti_disponibili: v.posti_totali,
              disponibile: true, is_slot: true, is_pool: true,
              messaggio: "Attiva un nuovo Pop-Bus"
          }));
          console.log(`🔍 [DEBUG] Proposte fallback generate: ${veicoliPool.length}`);
      } catch (e) { console.error("⚠️ Fallback non disponibile (ERRORE DB):", e); }
  }

  // 6. CONCLUSIONE
  const risultatiFinali = [...risultatiCondivise, ...risultatiSlotPrivati, ...risultatiPool];
  console.log(`✅ [DEBUG] Totale risultati calcolati: ${risultatiFinali.length}`);
  
  return risultatiFinali.length > 0 ? await formatResults(richiesta, risultatiFinali) : [];
}