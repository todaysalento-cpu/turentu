import { pool } from '../../db/db.js';
import { getIO } from '../../socket.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Clustering Dinamico: Raggruppa per percorso E slot temporale (es. ora esatta)
    // Usiamo DATE_TRUNC per creare finestre di partenza (es. ogni ora)
    const { rows: clusters } = await client.query(`
      SELECT 
        start_node_id, end_node_id,
        DATE_TRUNC('hour', start_datetime) as slot_orario,
        SUM(posti_richiesti) as posti_totali,
        (ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) as dist_km,
        CASE 
          WHEN (ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) <= 20 THEN 'corto'
          WHEN (ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) <= 60 THEN 'medio'
          ELSE 'lungo'
        END as tipo_raggio
      FROM richieste_pop_bus r
      JOIN nodi_direttrice n1 ON r.start_node_id = n1.id
      JOIN nodi_direttrice n2 ON r.end_node_id = n2.id
      WHERE r.stato = 'in_attesa'
      GROUP BY start_node_id, end_node_id, slot_orario, n1.posizione, n2.posizione
    `);

    for (const c of clusters) {
      // 2. UPSERT Direttrici: Include partenza_prevista per permettere più corse sulla stessa tratta
      const { rows: dir } = await client.query(`
        INSERT INTO direttrici_virtuali (
            stato, tipo_raggio, distanza_totale_km, soglia_attivazione, partenza_prevista, start_node_id, end_node_id
        )
        VALUES ('in_formazione', $1, $2, (SELECT costo_km_base * $2 FROM config_soglie WHERE tipo = $1), $3, $4, $5)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista) 
        DO UPDATE SET stato = 'in_formazione'
        RETURNING id
      `, [c.tipo_raggio, c.dist_km, c.slot_orario, c.start_node_id, c.end_node_id]);

      // 3. UPSERT Segmenti: Include direttrice_id per evitare conflitti tra bus diversi
      await client.query(`
        INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (direttrice_id, start_node_id, end_node_id) 
        DO UPDATE SET posti_occupati = segmenti.posti_occupati + EXCLUDED.posti_occupati
      `, [dir[0].id, c.start_node_id, c.end_node_id, c.posti_totali]);
    }

    // Segna le richieste come convertite
    await client.query(`UPDATE richieste_pop_bus SET stato = 'convertita' WHERE stato = 'in_attesa'`);

    // 4. Validazione Soglia
    const { rows: direttriciAttivate } = await client.query(`
      WITH analisi AS (
        SELECT d.id, SUM(s.posti_occupati * 2.5) as ricavo_stimato, d.soglia_attivazione
        FROM direttrici_virtuali d
        JOIN segmenti s ON d.id = s.direttrice_id
        WHERE d.stato = 'in_formazione'
        GROUP BY d.id, d.soglia_attivazione
      )
      UPDATE direttrici_virtuali
      SET stato = 'in_attesa_autista'
      FROM analisi
      WHERE direttrici_virtuali.id = analisi.id AND analisi.ricavo_stimato >= analisi.soglia_attivazione
      RETURNING direttrici_virtuali.id
    `);

    // 5. Dispatching
    for (const r of direttriciAttivate) {
      const { rows: autisti } = await client.query(`
        SELECT id FROM utente WHERE tipo = 'autista' ORDER BY rating DESC LIMIT 5
      `);

      for (const autista of autisti) {
        await client.query(`
          INSERT INTO offerte_autisti (direttrice_id, autista_id, stato, expires_at)
          VALUES ($1, $2, 'inviata', NOW() + INTERVAL '15 minutes')
          ON CONFLICT DO NOTHING
        `, [r.id, autista.id]);
      }
      getIO().emit('nuova_proposta_popbus', { direttrice_id: r.id });
    }

    await client.query('COMMIT');
    console.log(`✅ [WORKER] Processo completato: ${direttriciAttivate.length} nuove direttrici attivate.`);
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Errore critico nel Worker Pop-Bus:', err);
    throw err;
  } finally {
    client.release();
  }
}