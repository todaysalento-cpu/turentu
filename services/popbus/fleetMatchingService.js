import { pool } from '../../db/db.js';

/**
 * Trova tutti i veicoli compatibili con il tipo di servizio per un segmento,
 * a prescindere dalla distanza o includendo la distanza come semplice metadato.
 */
export async function getVeicoliCompatibiliPerSegmento(startNodeId, tipoServizio, maxDistanzaKm = 50) {
  const query = `
    SELECT 
      v.id as veicolo_id,
      v.driver_id,
      v.servizi as tipo_servizio,
      COALESCE(t.euro_km, 0.50) as euro_km,
      CASE 
        WHEN v.posizione_corrente IS NOT NULL THEN ST_Distance(n.posizione::geography, v.posizione_corrente::geography) / 1000 
        ELSE NULL 
      END as distanza_km
    FROM veicolo v
    JOIN nodi_direttrice n ON n.id = $1
    LEFT JOIN tariffe t ON t.veicolo_id = v.id
    WHERE v.servizi::text ILIKE '%' || $2 || '%'
      -- Se vuoi mantenere un filtro di sicurezza molto ampio (es. 50km) per evitare veicoli dall'altra parte del mondo, 
      -- oppure puoi rimuovere del tutto la riga ST_DWithin se la flotta è circoscritta.
      AND (v.posizione_corrente IS NULL OR ST_DWithin(n.posizione::geography, v.posizione_corrente::geography, $3 * 1000))
    ORDER BY distanza_km ASC NULLS LAST
  `;

  const values = [startNodeId, tipoServizio, maxDistanzaKm];
  const { rows } = await pool.query(query, values);
  
  return rows;
}

/**
 * Seleziona il veicolo ottimale (ordinato per vicinanza o convenienza) tra tutti i disponibili.
 */
export async function getMigliorVeicoloPerSoglia(startNodeId, tipoServizio) {
  const candidati = await getVeicoliCompatibiliPerSegmento(startNodeId, tipoServizio);
  if (!candidati || candidati.length === 0) return null;

  return candidati[0];
}

/**
 * Restituisce l'elenco di tutti i potenziali destinatari per il dispatching della direttrice,
 * rimuovendo i vincoli rigidi di raggio ristretto.
 */
export async function getDestinatariDispatching(direttriceId) {
  const query = `
    SELECT DISTINCT v.driver_id, v.id as veicolo_id
    FROM direttrici_virtuali d
    JOIN segmenti s ON s.direttrice_id = d.id
    JOIN veicolo v ON v.servizi::text ILIKE '%' || d.tipo_servizio || '%'
    WHERE d.id = $1 
      AND v.driver_id IS NOT NULL
  `;
  
  const { rows } = await pool.query(query, [direttriceId]);
  return rows;
}