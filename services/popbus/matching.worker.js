import { pool } from '../../db/db.js';
import { dispatchDirettriciAttive } from './dispatchService.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  console.log('🔄 [WORKER] Avvio cluster pop-bus...');

  try {
    await client.query('BEGIN');

    // 1. CLUSTERING (Raggruppato per tratta e slot, ignorando la classe per il raggruppamento)
    console.log('🔍 [WORKER] Fase 1: Ricerca e clustering delle richieste in attesa...');
    const { rows: clusters } = await client.query(`
      SELECT 
        r.start_node_id,
        r.end_node_id,
        TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM r.start_datetime) / 3600) * 3600) as slot_orario,
        SUM(r.posti_richiesti) as posti_totali,
        MAX(r.classe) as classe_riferimento,
        MAX(ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) as dist_km
      FROM richieste_pop_bus r
      JOIN nodi_direttrice n1 ON r.start_node_id = n1.id
      JOIN nodi_direttrice n2 ON r.end_node_id = n2.id
      WHERE r.stato = 'in_attesa'
        AND r.start_node_id <> r.end_node_id
      GROUP BY r.start_node_id, r.end_node_id, slot_orario
    `);

    console.log(`📦 [WORKER] Trovati ${clusters.length} cluster di richieste validi da elaborare.`);

    const segmentiCoinvoltiIds = [];

    for (const [index, c] of clusters.entries()) {
      console.log(`--- Elaborazione Cluster [${index + 1}/${clusters.length}] ---`);
      console.log(`    Tratta: Node ${c.start_node_id} -> Node ${c.end_node_id} | Slot: ${c.slot_orario} | Posti Totali: ${c.posti_totali}`);

      // Inserimento direttrice unificata (contenitore geo-temporale)
      const { rows: dir } = await client.query(`
        INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
        VALUES ('in_formazione', $1, $2, $3, $4)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista)
        DO UPDATE SET tipo_servizio = EXCLUDED.tipo_servizio
        RETURNING id
      `, [c.slot_orario, c.start_node_id, c.end_node_id, c.classe_riferimento]);

      const direttriceId = dir[0].id;
      console.log(`    ✅ Direttrice virtuale assicurata con ID: ${direttriceId}`);

      // Associazione di TUTTE le richieste dello slot alla direttrice nella tabella ponte
      await client.query(`
        INSERT INTO direttrici_richieste (direttrice_id, richiesta_id)
        SELECT $1, r.id
        FROM richieste_pop_bus r
        WHERE r.stato = 'in_attesa'
          AND r.start_node_id = $2
          AND r.end_node_id = $3
          AND TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM r.start_datetime) / 3600) * 3600) = $4
        ON CONFLICT DO NOTHING
      `, [direttriceId, c.start_node_id, c.end_node_id, c.slot_orario]);

      // GESTIONE SEGMENTO UNICO: Verifica se esiste un segmento per la direttrice e tratta a prescindere dallo stato
      let segmentoId;
      const { rows: existingSeg } = await client.query(`
        SELECT id, stato FROM segmenti 
        WHERE direttrice_id = $1 AND start_node_id = $2 AND end_node_id = $3
        LIMIT 1
      `, [direttriceId, c.start_node_id, c.end_node_id]);

      if (existingSeg.length > 0) {
        segmentoId = existingSeg[0].id;
        const statoCorrente = existingSeg[0].stato;

        if (statoCorrente === 'in_attesa') {
          // Se è ancora in attesa, accumuliamo i posti sullo stesso segmento
          await client.query(`
            UPDATE segmenti 
            SET posti_occupati = posti_occupati + $1 
            WHERE id = $2
          `, [c.posti_totali, segmentoId]);
          console.log(`    ✅ Segmento esistente 'in_attesa' aggiornato con ID: ${segmentoId}`);
        } else {
          // Se il segmento esistente è già attivo, creiamo un nuovo segmento parallelo (nuova corsa)
          const { rows: newSeg } = await client.query(`
            INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato)
            VALUES ($1, $2, $3, $4, 'in_attesa')
            RETURNING id
          `, [direttriceId, c.start_node_id, c.end_node_id, c.posti_totali]);
          segmentoId = newSeg[0].id;
          console.log(`    ✅ Segmento precedente già attivo. Creato nuovo segmento parallelo 'in_attesa' con ID: ${segmentoId}`);
        }
      } else {
        try {
          const { rows: newSeg } = await client.query(`
            INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato)
            VALUES ($1, $2, $3, $4, 'in_attesa')
            RETURNING id
          `, [direttriceId, c.start_node_id, c.end_node_id, c.posti_totali]);
          segmentoId = newSeg[0].id;
          console.log(`    ✅ Nuovo segmento creato 'in_attesa' con ID: ${segmentoId}`);
        } catch (insertErr) {
          if (insertErr.code === '23505') {
            const { rows: fallbackSeg } = await client.query(`
              SELECT id, stato FROM segmenti 
              WHERE direttrice_id = $1 AND start_node_id = $2 AND end_node_id = $3
              LIMIT 1
            `, [direttriceId, c.start_node_id, c.end_node_id]);
            
            if (fallbackSeg.length > 0) {
              segmentoId = fallbackSeg[0].id;
              if (fallbackSeg[0].stato === 'in_attesa') {
                await client.query(`
                  UPDATE segmenti 
                  SET posti_occupati = posti_occupati + $1 
                  WHERE id = $2
                `, [c.posti_totali, segmentoId]);
                console.log(`    ⚠️ Conflitto gestito: aggiornato segmento esistente ID: ${segmentoId}`);
              } else {
                const { rows: forcedNew } = await client.query(`
                  INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato)
                  VALUES ($1, $2, $3, $4, 'in_attesa')
                  RETURNING id
                `, [direttriceId, c.start_node_id, c.end_node_id, c.posti_totali]);
                segmentoId = forcedNew[0].id;
                console.log(`    ✅ Conflitto gestito (già attivo): creato nuovo segmento parallelo con ID: ${segmentoId}`);
              }
            } else {
              const { rows: forcedNew } = await client.query(`
                INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato)
                VALUES ($1, $2, $3, $4, 'in_attesa')
                RETURNING id
              `, [direttriceId, c.start_node_id, c.end_node_id, c.posti_totali]);
              segmentoId = forcedNew[0].id;
              console.log(`    ✅ Nuovo segmento parallelo forzato creato con ID: ${segmentoId}`);
            }
          } else {
            throw insertErr;
          }
        }
      }

      if (segmentoId && !segmentiCoinvoltiIds.includes(Number(segmentoId))) {
        segmentiCoinvoltiIds.push(Number(segmentoId));
      }

      // Inserimento / Aggiornamento missioni_ritorno legate al segmento
      await client.query(`
        INSERT INTO missioni_ritorno (
          segmento_id, direttrice_id, nodo_origine, capolinea_finale_id, orario_previsto, stato, tempo_max_attesa
        )
        VALUES (
          $1, $2, $3, $4, 
          ($5::timestamptz + 
            CASE 
              WHEN UPPER($6) = 'EXTRAURBANO' THEN INTERVAL '30 minutes'
              WHEN UPPER($6) = 'SCOLASTICO' THEN INTERVAL '3 hours'
              ELSE INTERVAL '15 minutes'
            END
          ), 
          'in_attesa',
          CASE 
            WHEN UPPER($6) = 'EXTRAURBANO' THEN 45
            WHEN UPPER($6) = 'SCOLASTICO' THEN 180
            ELSE 20
          END
        )
        ON CONFLICT (segmento_id, capolinea_finale_id) 
        DO UPDATE SET 
          orario_previsto = EXCLUDED.orario_previsto,
          nodo_origine = EXCLUDED.nodo_origine
      `, [segmentoId, direttriceId, c.end_node_id, c.end_node_id, c.slot_orario, c.classe_riferimento]);
    }

    if (segmentiCoinvoltiIds.length === 0) {
      console.log('ℹ️ [WORKER] Nessun segmento da valutare in questa esecuzione.');
      await client.query('COMMIT');
      return;
    }

    // 2. CALCOLO ATTIVAZIONE (Valuta solo i segmenti effettivamente toccati in questo giro)
    console.log('💰 [WORKER] Fase 2: Calcolo economico e attivazione dei segmenti coinvolti...');
    
    const { rows: segmentiAttivati } = await client.query(`
      WITH ricavi_segmento AS (
        SELECT 
          s.id as segmento_id,
          s.direttrice_id,
          s.tempo_stimato,
          s.ordine_sequenziale,
          (
            ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000 +
            COALESCE(ST_Distance(n_orig.posizione::geography, n1.posizione::geography)/1000, 0) +
            COALESCE(ST_Distance(n2.posizione::geography, n_dest.posizione::geography)/1000, 0)
          ) as km_segmento,
          COALESCE(s.posti_occupati * 2.50, 0) as ricavo_attuale
        FROM segmenti s
        JOIN nodi_direttrice n1 ON s.start_node_id = n1.id
        JOIN nodi_direttrice n2 ON s.end_node_id = n2.id
        LEFT JOIN missioni_ritorno mr ON mr.segmento_id = s.id
        LEFT JOIN nodi_direttrice n_orig ON mr.nodo_origine = n_orig.id
        LEFT JOIN nodi_direttrice n_dest ON mr.capolinea_finale_id = n_dest.id
        WHERE s.id = ANY($1::int[]) AND s.stato = 'in_attesa'
        GROUP BY s.id, s.direttrice_id, s.tempo_stimato, s.ordine_sequenziale, s.posti_occupati, n1.posizione, n2.posizione, n_orig.posizione, n_dest.posizione
      ),
      calcolo_orari AS (
        SELECT 
          rs.segmento_id, 
          rs.direttrice_id,
          d.partenza_prevista + (SUM(COALESCE(rs.tempo_stimato, 0)) OVER (
              PARTITION BY rs.direttrice_id ORDER BY rs.ordine_sequenziale
            ) * INTERVAL '1 minute') as calculated_start,
          rs.ricavo_attuale,
          0.50 * rs.km_segmento as soglia_dinamica_segmento
        FROM ricavi_segmento rs
        JOIN direttrici_virtuali d ON rs.direttrice_id = d.id
      ),
      update_segmenti AS (
        UPDATE segmenti s
        SET start_datetime = co.calculated_start, stato = 'attivo', ricavo_stimato = co.ricavo_attuale
        FROM calcolo_orari co
        WHERE s.id = co.segmento_id
          AND co.ricavo_attuale >= COALESCE(co.soglia_dinamica_segmento, 0)
        RETURNING s.id, s.direttrice_id, s.stato
      ),
      update_direttrici AS (
        UPDATE direttrici_virtuali dv
        SET stato = 'attivo'
        FROM update_segmenti us
        WHERE dv.id = us.direttrice_id AND dv.stato = 'in_formazione'
        RETURNING dv.id
      )
      SELECT id, direttrice_id, stato FROM update_segmenti
    `, [segmentiCoinvoltiIds]);

    console.log(`🚀 [WORKER] Segmenti passati allo stato 'attivo': ${segmentiAttivati.length}`);
    segmentiAttivati.forEach(t => console.log(`    - Segmento ID: ${t.id} (Direttrice ID: ${t.direttrice_id})`));

    // 3. AUTO-UPGRADE
    console.log('🔄 [WORKER] Fase 3: Esecuzione auto-upgrade delle richieste...');
    await client.query(`
      UPDATE richieste_pop_bus r
      SET target_missione_id = d_target.id
      FROM direttrici_virtuali d_source
      JOIN direttrici_virtuali d_target ON d_source.start_node_id = d_target.start_node_id
         AND d_source.end_node_id = d_target.end_node_id
      WHERE r.target_missione_id = d_source.id
        AND d_source.stato = 'in_attesa'
        AND d_target.stato = 'attivo'
    `);

    // 4. DELEGATED DISPATCH
    console.log('📡 [WORKER] Fase 4: Invio al servizio di dispatch...');
    const countAttive = await dispatchDirettriciAttive(segmentiAttivati, client);

    await client.query('COMMIT');
    console.log(`✨ [WORKER] Transazione completata con successo. Segmenti attivi dispatchati: ${countAttive}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [WORKER ERROR] Errore critico durante l\'elaborazione, eseguito ROLLBACK:', err);
    throw err;
  } finally {
    client.release();
    console.log('🔌 [WORKER] Connessione al database rilasciata.\n');
  }
}