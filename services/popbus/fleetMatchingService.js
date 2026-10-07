import { pool } from '../../db/db.js';

/**
 * Trova tutti i veicoli compatibili con il tipo di servizio per un segmento,
 * a prescindere dalla distanza o includendo la distanza come semplice metadato.
 */
export async function getVeicoliCompatibiliPerSegmento(startNodeId, tipoServizio, maxDistanzaKm = 50, client = pool) {
  console.log(`🔎 [MATCHING DEBUG] Ricerca veicoli compatibili -> NodeId: ${startNodeId}, Servizio: '${tipoServizio}', MaxDistanza: ${maxDistanzaKm}km`);
  
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
      AND (v.posizione_corrente IS NULL OR ST_DWithin(n.posizione::geography, v.posizione_corrente::geography, $3 * 1000))
    ORDER BY distanza_km ASC NULLS LAST
  `;

  const values = [startNodeId, tipoServizio, maxDistanzaKm];
  const { rows } = await client.query(query, values);
  
  console.log(`🔎 [MATCHING DEBUG] Veicoli trovati dopo il filtro: ${rows.length}`, rows);
  return rows;
}

/**
 * Seleziona il veicolo ottimale (ordinato per vicinanza o convenienza) tra tutti i disponibili.
 */
export async function getMigliorVeicoloPerSoglia(startNodeId, tipoServizio, client = pool) {
  const candidati = await getVeicoliCompatibiliPerSegmento(startNodeId, tipoServizio, 50, client);
  if (!candidati || candidati.length === 0) return null;

  return candidati[0];
}

/**
 * Restituisce l'elenco di tutti i potenziali destinatari per il dispatching della direttrice,
 * rimuovendo i vincoli rigidi di raggio ristretto.
 */
export async function getDestinatariDispatching(direttriceId, client = pool) {
  console.log(`🚚 [MATCHING DEBUG] Avvio getDestinatariDispatching per Direttrice ID: ${direttriceId}`);

  // Prima facciamo un check per vedere che tipo di servizio ha la direttrice e quanti veicoli totali esistono
  const { rows: infoDir } = await client.query(`SELECT id, tipo_servizio, start_node_id FROM direttrici_virtuali WHERE id = $1`, [direttriceId]);
  console.log(`🚚 [MATCHING DEBUG] Info direttrice recuperate dal DB:`, infoDir[0]);

  const { rows: tuttiVeicoli } = await client.query(`SELECT id, driver_id, servizi, posizione_corrente IS NOT NULL as ha_posizione FROM veicolo`);
  console.log(`🚚 [MATCHING DEBUG] Stato attuale di TUTTI i veicoli nel DB (${tuttiVeicoli.length} totali):`, tuttiVeicoli);

  const query = `
    SELECT DISTINCT v.driver_id, v.id as veicolo_id
    FROM direttrici_virtuali d
    JOIN segmenti s ON s.direttrice_id = d.id
    JOIN veicolo v ON v.servizi::text ILIKE '%' || d.tipo_servizio || '%'
    WHERE d.id = $1 
      AND v.driver_id IS NOT NULL
  `;
  
  const { rows } = await client.query(query, [direttriceId]);
  console.log(`🚚 [MATCHING DEBUG] Destinatari finali trovati con la query di dispatch: ${rows.length}`, rows);
  
  return rows;
}