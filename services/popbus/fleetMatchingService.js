import { pool } from '../../db/db.js';

/**
 * Trova tutti i veicoli compatibili con il tipo di servizio per un segmento.
 */
export async function getVeicoliCompatibiliPerSegmento(startNodeId, tipoServizio, maxDistanzaKm = 50, client = pool) {
  console.log(`🔎 [MATCHING DEBUG] Ricerca veicoli compatibili -> NodeId: ${startNodeId}, Servizio: '${tipoServizio}'`);
  
  const query = `
    SELECT 
      v.id as veicolo_id,
      v.driver_id,
      v.servizi as tipo_servizio,
      COALESCE(t.euro_km, 0.50) as euro_km,
      NULL::numeric as distanza_km
    FROM veicolo v
    LEFT JOIN tariffe t ON t.veicolo_id = v.id
    WHERE v.servizi::text ILIKE '%' || $1 || '%'
  `;

  const { rows } = await client.query(query, [tipoServizio]);
  console.log(`🔎 [MATCHING DEBUG] Veicoli trovati dopo il filtro: ${rows.length}`, rows);
  return rows;
}

/**
 * Seleziona il veicolo ottimale tra tutti i disponibili.
 */
export async function getMigliorVeicoloPerSoglia(startNodeId, tipoServizio, client = pool) {
  const candidati = await getVeicoliCompatibiliPerSegmento(startNodeId, tipoServizio, 50, client);
  if (!candidati || candidati.length === 0) return null;

  return candidati[0];
}

/**
 * Restituisce l'elenco di tutti i potenziali destinatari per il dispatching della direttrice.
 */
export async function getDestinatariDispatching(direttriceId, client = pool) {
  console.log(`🚚 [MATCHING DEBUG] Avvio getDestinatariDispatching per Direttrice ID: ${direttriceId}`);

  // 1. Recupera le info della direttrice
  const { rows: infoDir } = await client.query(`SELECT id, tipo_servizio, start_node_id FROM direttrici_virtuali WHERE id = $1`, [direttriceId]);
  console.log(`🚚 [MATCHING DEBUG] Info direttrice recuperate dal DB:`, infoDir[0]);

  // 2. Ispeziona i veicoli presenti nel DB (senza colonne inesistenti)
  const { rows: tuttiVeicoli } = await client.query(`SELECT id, driver_id, servizi FROM veicolo`);
  console.log(`🚚 [MATCHING DEBUG] Stato attuale di TUTTI i veicoli nel DB (${tuttiVeicoli.length} totali):`, tuttiVeicoli);

  // 3. Query di dispatching pulita
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