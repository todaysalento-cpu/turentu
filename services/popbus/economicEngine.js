export async function calcolaAttivazioneEconomica(client, segmentiCoinvoltiIds) {
  if (segmentiCoinvoltiIds.length === 0) return [];

  const idsListSql = segmentiCoinvoltiIds.join(',');
  console.log(`\n💰 [WORKER - ECONOMIC ENGINE] Avvio calcolo economico per ${segmentiCoinvoltiIds.length} segmenti: [${idsListSql}]`);

  const { rows: segmentiAttivati } = await client.query(`
    WITH ricavi_segmento AS (
      SELECT 
        s.id as segmento_id,
        s.direttrice_id,
        s.start_node_id,
        s.end_node_id,
        s.tempo_stimato,
        s.ordine_sequenziale,
        s.posti_occupati,
        (
          ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000 +
          COALESCE(ST_Distance(n_orig.posizione::geography, n1.posizione::geography)/1000, 0) +
          COALESCE(ST_Distance(n2.posizione::geography, n_dest.posizione::geography)/1000, 0)
        ) as km_segmento,
        (
          SELECT COALESCE(SUM(r_sub.prezzo), 0)
          FROM richieste_pop_bus r_sub
          JOIN segmenti r_start_seg ON r_start_seg.direttrice_id = s.direttrice_id AND r_start_seg.start_node_id = r_sub.start_node_id
          JOIN segmenti r_end_seg ON r_end_seg.direttrice_id = s.direttrice_id AND r_end_seg.end_node_id = r_sub.end_node_id
          WHERE r_sub.direttrice_id = s.direttrice_id
            AND r_sub.stato IN ('in_attesa', 'in_lavorazione')
            AND r_start_seg.ordine_sequenziale >= s.ordine_sequenziale
            AND r_end_seg.ordine_sequenziale <= (
              SELECT MAX(sub_s.ordine_sequenziale) FROM segmenti sub_s 
              WHERE sub_s.direttrice_id = s.direttrice_id AND sub_s.end_node_id = r_sub.end_node_id
            )
        ) as ricavo_attuale
      FROM segmenti s
      JOIN nodi_direttrice n1 ON s.start_node_id = n1.id
      JOIN nodi_direttrice n2 ON s.end_node_id = n2.id
      JOIN direttrici_virtuali dv ON s.direttrice_id = dv.id
      LEFT JOIN missioni_ritorno mr ON mr.segmento_id = s.id
      LEFT JOIN nodi_direttrice n_orig ON mr.nodo_origine = n_orig.id
      LEFT JOIN nodi_direttrice n_dest ON mr.capolinea_finale_id = n_dest.id
      WHERE s.id IN (${idsListSql}) AND s.stato = 'in_attesa'
    ),
    veicoli_disponibili_pool AS (
      SELECT 
        rs.segmento_id,
        v.id as veicolo_id,
        COALESCE(v.posti_totali, 50) as capacita_veicolo,
        COALESCE(t.euro_km, 0.50) as euro_km_veicolo
      FROM ricavi_segmento rs
      JOIN nodi_direttrice n_partenza ON n_partenza.id = rs.start_node_id
      JOIN veicolo v ON true
      JOIN disponibilita_veicolo d ON d.veicolo_id = v.id
      LEFT JOIN tariffe t ON t.veicolo_id = v.id AND t.tipo = 'standard'
      WHERE v.id NOT IN (
        SELECT veicolo_id FROM direttrici_virtuali 
        WHERE veicolo_id IS NOT NULL AND stato IN ('in_formazione', 'in_attesa_autista', 'attivo')
      )
    ),
    parametri_pool_ottimali AS (
      SELECT 
        segmento_id,
        MIN(euro_km_veicolo) as min_euro_km,
        MAX(capacita_veicolo) as capacita_veicolo
      FROM veicoli_disponibili_pool
      GROUP BY segmento_id
    ),
    costo_attivazione AS (
      SELECT 
        rs.segmento_id,
        rs.direttrice_id,
        rs.start_node_id,
        rs.end_node_id,
        rs.tempo_stimato,
        rs.ordine_sequenziale,
        rs.posti_occupati,
        rs.km_segmento,
        rs.ricavo_attuale as ricavo_aggregato,
        COALESCE(ppo.min_euro_km, 0.50) as euro_km_selezionato,
        COALESCE(ppo.capacita_veicolo, 50) as capacita_veicolo
      FROM ricavi_segmento rs
      LEFT JOIN parametri_pool_ottimali ppo ON rs.segmento_id = ppo.segmento_id
    ),
    calcolo_orari AS (
      SELECT 
        ca.segmento_id, 
        ca.direttrice_id,
        ca.start_node_id,
        ca.end_node_id,
        ca.ordine_sequenziale,
        d.partenza_prevista + (SUM(COALESCE(rs_t.tempo_stimato, 0)) OVER (
          PARTITION BY ca.direttrice_id ORDER BY rs_t.ordine_sequenziale
        ) * INTERVAL '1 minute') as calculated_start,
        ca.ricavo_aggregato as ricavo_attuale,
        ca.posti_occupati,
        ca.capacita_veicolo,
        (ca.euro_km_selezionato * ca.km_segmento) as soglia_attivazione_minima
      FROM costo_attivazione ca
      JOIN direttrici_virtuali d ON ca.direttrice_id = d.id
      JOIN segmenti rs_t ON rs_t.id = ca.segmento_id
    ),
    segmenti_filtrati AS (
      SELECT co.*
      FROM calcolo_orari co
      WHERE co.ricavo_attuale >= COALESCE(co.soglia_attivazione_minima, 0)
        AND co.posti_occupati <= co.capacita_veicolo
        AND NOT EXISTS (
          SELECT 1 
          FROM calcolo_orari padre
          WHERE padre.direttrice_id = co.direttrice_id
            AND padre.ordine_sequenziale < co.ordine_sequenziale
            AND padre.ricavo_attuale >= COALESCE(padre.soglia_attivazione_minima, 0)
            AND padre.posti_occupati <= padre.capacita_veicolo
        )
    ),
    update_segmenti AS (
      UPDATE segmenti s
      SET start_datetime = sf.calculated_start, stato = 'attivo', ricavo_stimato = sf.ricavo_attuale
      FROM segmenti_filtrati sf
      WHERE s.id = sf.segmento_id
      RETURNING s.id, s.direttrice_id, s.stato, s.start_node_id, s.ricavo_stimato
    )
    SELECT id, direttrice_id, stato, start_node_id, ricavo_stimato FROM update_segmenti
  `);

  console.log(`📊 [WORKER - ECONOMIC ENGINE] Analisi completata.`);
  console.log(`🚀 [WORKER] Segmenti passati allo stato 'attivo': ${segmentiAttivati.length}`);
  
  if (segmentiAttivati.length > 0) {
    segmentiAttivati.forEach(seg => {
      console.log(`   ✨ Attivato -> Segmento ID: ${seg.id} | Direttrice ID: ${seg.direttrice_id} | Nodo Start: ${seg.start_node_id} | Ricavo Stimato: ${seg.ricavo_stimato} €`);
    });
  } else {
    console.log(`   ⚠️ Nessun segmento ha soddisfatto i requisiti di soglia economica o capienza in questo ciclo.`);
  }

  return segmentiAttivati;
}