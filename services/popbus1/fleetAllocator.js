export async function assegnaVeicoliEDirettrici(client, segmentiAttivati) {
  console.log(`\n🚚 [ASSIGNMENT ENGINE] ----------------------------------------`);
  console.log(`🚚 [ASSIGNMENT ENGINE] Avvio assegnazione veicoli e aggiornamento per ${segmentiAttivati.length} segmenti attivati.`);

  for (const seg of segmentiAttivati) {
    console.log(`\n   🔹 Elaborazione Direttrice ID: ${seg.direttrice_id} (Segmento ID attivo: ${seg.id}, Start Node: ${seg.start_node_id})`);

    const { rows: dirCheck } = await client.query(
      `SELECT veicolo_id, stato FROM direttrici_virtuali WHERE id = $1`,
      [seg.direttrice_id]
    );

    if (dirCheck.length > 0) {
      const veicoloCorrente = dirCheck[0].veicolo_id;
      console.log(`      - Stato attuale direttrice: '${dirCheck[0].stato}' | Veicolo già assegnato: ${veicoloCorrente ? veicoloIdAssegnato : 'Nessuno'}`);

      if (!veicoloCorrente) {
        console.log(`      - Ricerca veicolo libero più vicino al nodo ${seg.start_node_id}...`);
        
        const { rows: veicoliLiberi } = await client.query(`
          SELECT v.id 
          FROM veicolo v
          JOIN disponibilita_veicolo d ON v.id = d.veicolo_id
          CROSS JOIN nodi_direttrice n_partenza
          WHERE n_partenza.id = $1
            AND v.id NOT IN (
              SELECT veicolo_id FROM direttrici_virtuali 
              WHERE veicolo_id IS NOT NULL AND stato IN ('in_formazione', 'in_attesa_autista', 'attivo')
            )
          ORDER BY ST_Distance(COALESCE(d.coord, n_partenza.posizione)::geography, n_partenza.posizione::geography) ASC
          LIMIT 1
        `, [seg.start_node_id]);

        if (veicoliLiberi.length > 0) {
          const veicoloIdAssegnato = veicoliLiberi[0].id;
          await client.query(`
            UPDATE direttrici_virtuali 
            SET veicolo_id = $1, stato = 'in_attesa_autista'
            WHERE id = $2
          `, [veicoloIdAssegnato, seg.direttrice_id]);
          
          console.log(`      ✨ [VEICOLO ASSEGNATO] Veicolo ID ${veicoloIdAssegnato} associato con successo alla direttrice ${seg.direttrice_id}. Stato aggiornato a 'in_attesa_autista'.`);
        } else {
          console.log(`      ⚠️ [ATTENZIONE] Nessun veicolo disponibile trovato nel pool per la direttrice ${seg.direttrice_id} in questo ciclo.`);
        }
      }
    }

    console.log(`      - Aggiornamento distanza totale e soglia economica per la direttrice ${seg.direttrice_id}...`);
    await client.query(`
      UPDATE direttrici_virtuali dv
      SET 
        distanza_totale_km = sub.tot_km,
        soglia_attivazione = sub.tot_soglia
      FROM (
        SELECT 
          s.direttrice_id,
          SUM(ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) as tot_km,
          SUM(ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000 * 0.50) as tot_soglia
        FROM segmenti s
        JOIN nodi_direttrice n1 ON s.start_node_id = n1.id
        JOIN nodi_direttrice n2 ON s.end_node_id = n2.id
        WHERE s.direttrice_id = $1
        GROUP BY s.direttrice_id
      ) sub
      WHERE dv.id = sub.direttrice_id;
    `, [seg.direttrice_id]);
    console.log(`      📊 [TOTALI AGGIORNATI] Distanza e soglia ricalcolate per la direttrice ${seg.direttrice_id}.`);
  }

  // AUTO-UPGRADE
  console.log(`\n🔄 [AUTO-UPGRADE] Avvio controllo ottimizzazione/spostamento richieste verso direttrici attive...`);
  const upgradeResult = await client.query(`
    UPDATE richieste_pop_bus r
    SET direttrice_id = d_target.id
    FROM direttrici_virtuali d_source
    JOIN direttrici_virtuali d_target ON d_source.partenza_prevista = d_target.partenza_prevista
        AND d_target.tipo_servizio = d_source.tipo_servizio
    WHERE r.direttrice_id = d_source.id
      AND d_source.stato = 'in_formazione'
      AND d_target.stato IN ('in_attesa_autista', 'attivo')
      AND d_source.id <> d_target.id
  `);
  console.log(`🔄 [AUTO-UPGRADE] Processo completato. Righe richieste aggiornate/spostate: ${upgradeResult.rowCount || 0}`);
  console.log(`🚚 [ASSIGNMENT ENGINE] ----------------------------------------\n`);
}