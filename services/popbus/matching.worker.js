import { pool } from '../db/db.js';
import { getIO } from '../../socket.js';

/**
 * Worker aggiornato con logica di Auto-Upgrade:
 * Migra le richieste verso direttrici di classe superiore attive,
 * rispettando il prezzo massimo preautorizzato dall'utente.
 */
export async function processaProposteDinamiche() {
  const client = await pool.connect();
  console.log('🔄 [WORKER] Avvio elaborazione cluster con logica multi-classe e Auto-Upgrade...');
  
  try {
    await client.query('BEGIN');

    // 1. Clustering Dinamico: Raggruppamento per percorso, slot orario E CLASSE richiesta
    const { rows: clusters } = await client.query(`
      SELECT start_node_id, end_node_id, classe,
             TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM start_datetime) / 3600) * 3600) as slot_orario,
             SUM(posti_richiesti) as posti_totali,
             (ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) as dist_km
      FROM richieste_pop_bus r
      JOIN nodi_direttrice n1 ON r.start_node_id = n1.id
      JOIN nodi_direttrice n2 ON r.end_node_id = n2.id
      WHERE r.stato = 'in_attesa'
      GROUP BY start_node_id, end_node_id, slot_orario, classe
    `);

    for (const c of clusters) {
      const { rows: dir } = await client.query(`
        INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, capacita_totale, classe)
        VALUES ('in_formazione', $1, $2, $3, 16, $4)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista, classe) 
        DO UPDATE SET stato = 'in_formazione'
        RETURNING id
      `, [c.slot_orario, c.start_node_id, c.end_node_id, c.classe]);

      const { rows: seg } = await client.query(`
        INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, distanza_km)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (direttrice_id, start_node_id, end_node_id) 
        DO UPDATE SET posti_occupati = segmenti.posti_occupati + EXCLUDED.posti_occupati
        RETURNING id
      `, [dir[0].id, c.start_node_id, c.end_node_id, c.posti_totali, c.dist_km]);

      await client.query(`
        INSERT INTO missioni_ritorno (segmento_id, direttrice_id, nodo_origine, capolinea_finale_id, orario_previsto, stato)
        VALUES ($1, $2, $3, $4, $5 + INTERVAL '1 hour', 'in_attesa')
        ON CONFLICT (segmento_id, capolinea_finale_id) DO NOTHING
      `, [seg[0].id, dir[0].id, c.end_node_id, c.end_node_id, c.slot_orario]);
    }

    // 2. Calcolo Orari e Validazione Redditività
    const { rows: tratteAttivate } = await client.query(`
      WITH calcolo_orari AS (
        SELECT s.id, s.direttrice_id,
               d.partenza_prevista + (SUM(COALESCE(prev.tempo_stimato, 0)) OVER (PARTITION BY s.direttrice_id ORDER BY s.ordine_sequenziale) * INTERVAL '1 minute') as calculated_start
        FROM segmenti s
        JOIN direttrici_virtuali d ON s.direttrice_id = d.id
        LEFT JOIN segmenti prev ON prev.direttrice_id = s.direttrice_id AND prev.ordine_sequenziale < s.ordine_sequenziale
        WHERE d.stato = 'in_formazione'
      ),
      analisi_redditivita AS (
        SELECT d.id as direttrice_id, 
               SUM(s.posti_occupati) as load_factor,
               SUM(s.distanza_km) as dist_totale,
               (SUM(s.posti_occupati) * 2.5) as ricavo_stimato
        FROM direttrici_virtuali d
        JOIN segmenti s ON d.id = s.direttrice_id
        WHERE d.stato = 'in_formazione'
        GROUP BY d.id
      )
      UPDATE segmenti s
      SET start_datetime = co.calculated_start,
          stato = CASE WHEN r.ricavo_stimato >= (r.dist_totale * 1.20) THEN 'attivo' ELSE 'in_attesa' END
      FROM calcolo_orari co
      JOIN analisi_redditivita r ON co.direttrice_id = r.direttrice_id
      WHERE s.id = co.id
      RETURNING s.direttrice_id, s.stato, (SELECT classe FROM direttrici_virtuali WHERE id = s.direttrice_id) as classe_assegnata
    `);

    // 3. LOGICA DI AUTO-UPGRADE (Consapevole del budget)
    // Migra le richieste verso una direttrice attiva solo se il prezzo stimato rispetta il budget
    await client.query(`
      UPDATE richieste_pop_bus r
      SET target_missione_id = d_target.id, classe = d_target.classe
      FROM direttrici_virtuali d_source
      JOIN direttrici_virtuali d_target ON d_source.start_node_id = d_target.start_node_id 
           AND d_source.end_node_id = d_target.end_node_id
           AND d_target.stato = 'attivo'
      WHERE r.target_missione_id = d_source.id
      AND d_source.stato = 'in_attesa'
      AND d_target.stato = 'attivo'
      AND d_target.prezzo_stimato <= r.prezzo_max_accettato
    `);

    // 4. Dispatching
    const processedDir = [...new Map(tratteAttivate.map(item => [item.direttrice_id, item])).values()];
    const activeDirIds = processedDir.filter(t => t.stato === 'attivo');
    
    if (activeDirIds.length > 0) {
      for (const t of activeDirIds) {
        await client.query(`
            UPDATE direttrici_virtuali 
            SET stato = 'in_attesa_autista'
            WHERE id = $1`, [t.direttrice_id]);
            
        getIO().emit('nuova_proposta_popbus', { 
            direttrice_id: t.direttrice_id, 
            classe: t.classe_assegnata 
        });
      }
    }

    await client.query('COMMIT');
    console.log(`✨ [WORKER] Ciclo completato. Attivate: ${activeDirIds.length} direttrici con migrazione automatica.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}