import { pool } from '../../db/db.js';
import { getIO } from '../../socket.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  console.log('🔄 [WORKER] Avvio cluster pop-bus (FIX CAPACITÀ VEICOLO)...');

  try {
    await client.query('BEGIN');

    // 1. CLUSTERING
    const { rows: clusters } = await client.query(`
      SELECT 
        r.start_node_id,
        r.end_node_id,
        r.classe,
        TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM r.start_datetime) / 3600) * 3600) as slot_orario,
        SUM(r.posti_richiesti) as posti_totali,
        (ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) as dist_km
      FROM richieste_pop_bus r
      JOIN nodi_direttrice n1 ON r.start_node_id = n1.id
      JOIN nodi_direttrice n2 ON r.end_node_id = n2.id
      WHERE r.stato = 'in_attesa'
      GROUP BY r.start_node_id, r.end_node_id, r.classe, slot_orario
    `);

    for (const c of clusters) {

      // ⚠️ NON USARE capacita_totale
      const { rows: dir } = await client.query(`
        INSERT INTO direttrici_virtuali (
          stato,
          partenza_prevista,
          start_node_id,
          end_node_id
        )
        VALUES ('in_formazione', $1, $2, $3)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista)
        DO UPDATE SET stato = 'in_formazione'
        RETURNING id
      `, [c.slot_orario, c.start_node_id, c.end_node_id]);

      const { rows: seg } = await client.query(`
        INSERT INTO segmenti (
          direttrice_id,
          start_node_id,
          end_node_id,
          posti_occupati,
          distanza_km
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (direttrice_id, start_node_id, end_node_id)
        DO UPDATE SET posti_occupati = segmenti.posti_occupati + EXCLUDED.posti_occupati
        RETURNING id
      `, [dir[0].id, c.start_node_id, c.end_node_id, c.posti_totali, c.dist_km]);

      await client.query(`
        INSERT INTO missioni_ritorno (
          segmento_id,
          direttrice_id,
          nodo_origine,
          capolinea_finale_id,
          orario_previsto,
          stato
        )
        VALUES ($1, $2, $3, $4, $5 + INTERVAL '1 hour', 'in_attesa')
        ON CONFLICT (segmento_id, capolinea_finale_id) DO NOTHING
      `, [seg[0].id, dir[0].id, c.end_node_id, c.end_node_id, c.slot_orario]);
    }

    // 2. CALCOLO ATTIVAZIONE
    const { rows: tratteAttivate } = await client.query(`
      WITH calcolo_orari AS (
        SELECT 
          s.id,
          s.direttrice_id,
          d.partenza_prevista
            + (SUM(COALESCE(s.tempo_stimato, 0)) OVER (
                PARTITION BY s.direttrice_id 
                ORDER BY s.ordine_sequenziale
              ) * INTERVAL '1 minute') as calculated_start
        FROM segmenti s
        JOIN direttrici_virtuali d ON s.direttrice_id = d.id
        WHERE d.stato = 'in_formazione'
      )
      UPDATE segmenti s
      SET 
        start_datetime = co.calculated_start,
        stato = 'attivo'
      FROM calcolo_orari co
      WHERE s.id = co.id
      RETURNING s.direttrice_id, s.stato
    `);

    // 3. AUTO-UPGRADE (FIXATO: niente colonne inesistenti)
    await client.query(`
      UPDATE richieste_pop_bus r
      SET 
        target_missione_id = d_target.id,
        classe = d_target.classe
      FROM direttrici_virtuali d_source
      JOIN direttrici_virtuali d_target 
        ON d_source.start_node_id = d_target.start_node_id
       AND d_source.end_node_id = d_target.end_node_id
      WHERE r.target_missione_id = d_source.id
        AND d_source.stato = 'in_attesa'
        AND d_target.stato = 'attivo'
    `);

    // 4. DISPATCH
    const activeDirIds = [
      ...new Map(tratteAttivate.map(t => [t.direttrice_id, t])).values()
    ];

    for (const t of activeDirIds) {
      await client.query(`
        UPDATE direttrici_virtuali
        SET stato = 'in_attesa_autista'
        WHERE id = $1
      `, [t.direttrice_id]);

      getIO().emit('nuova_proposta_popbus', {
        direttrice_id: t.direttrice_id,
        classe: t.classe_assegnata || null
      });
    }

    await client.query('COMMIT');

    console.log(`✨ [WORKER] OK. Direttrici attive: ${activeDirIds.length}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ WORKER ERROR:', err);
    throw err;
  } finally {
    client.release();
  }
}