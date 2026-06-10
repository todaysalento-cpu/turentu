import { pool } from '../../db/db.js';
import { getIO } from '../../socket.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Matching: Accumulo domanda
    const { rows: richieste } = await client.query(`
      SELECT id, posti_richiesti, start_node_id, end_node_id 
      FROM richieste_pop_bus WHERE stato = 'in_attesa'
    `);

    for (const req of richieste) {
      await client.query(`
        INSERT INTO segmenti (start_node_id, end_node_id, posti_occupati, direttrice_id, ordine_sequenziale)
        VALUES ($1, $2, $3, (SELECT direttrice_id FROM nodi_direttrice WHERE id = $1), (SELECT ordine FROM nodi_direttrice WHERE id = $1))
        ON CONFLICT (start_node_id, end_node_id) 
        DO UPDATE SET posti_occupati = segmenti.posti_occupati + EXCLUDED.posti_occupati
      `, [req.start_node_id, req.end_node_id, req.posti_richiesti]);
      
      await client.query(`UPDATE richieste_pop_bus SET stato = 'convertita' WHERE id = $1`, [req.id]);
    }

    // 2. Attivazione e identificazione direttrici valide
    const { rows: direttriciAttivate } = await client.query(`
      WITH calcolo_valori AS (
        SELECT 
            seg.id,
            seg.direttrice_id,
            ((seg.posti_occupati * 2.5 * 0.6) >= (1.2 * ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000)) as locale_ok,
            ((SUM(seg.posti_occupati) OVER(PARTITION BY seg.direttrice_id) * 2.5 * 0.6) >= 
             (SUM(1.2 * ST_Distance(n1.posizione::geography, n2.posizione::geography)/1000) OVER(PARTITION BY seg.direttrice_id) * d.moltiplicatore_costo)) as catena_ok,
            SUM(seg.tempo_stimato) OVER(PARTITION BY seg.direttrice_id) <= d.soglia_tempo_max as tempo_ok,
            (d.partenza_prevista + (SUM(seg.tempo_stimato) OVER(PARTITION BY seg.direttrice_id ORDER BY seg.ordine_sequenziale) * INTERVAL '1 minute')) 
            BETWEEN n2.finestra_oraria_min AND n2.finestra_oraria_max as transito_ok,
            (n2.finestra_oraria_min IS NULL) as finestra_nulla
        FROM segmenti seg
        JOIN nodi_direttrice n1 ON seg.start_node_id = n1.id
        JOIN nodi_direttrice n2 ON seg.end_node_id = n2.id
        JOIN direttrici_virtuali d ON seg.direttrice_id = d.id
        WHERE seg.stato = 'in_attesa'
      ),
      segmenti_validi AS (
        SELECT id, direttrice_id 
        FROM calcolo_valori 
        WHERE (locale_ok OR catena_ok) AND tempo_ok = TRUE AND (transito_ok OR finestra_nulla)
      )
      UPDATE segmenti s
      SET stato = 'attivo'
      FROM segmenti_validi sv
      WHERE s.id = sv.id
      RETURNING s.direttrice_id
    `);

    // 3. Dispatching agli Autisti
    const dirIds = [...new Set(direttriciAttivate.map(r => r.direttrice_id))];
    
    for (const dirId of dirIds) {
      await client.query(`UPDATE direttrici_virtuali SET stato = 'in_attesa_autista' WHERE id = $1`, [dirId]);
      
      const { rows: autisti } = await client.query(`
        SELECT id FROM utente WHERE tipo = 'autista' ORDER BY rating DESC LIMIT 5
      `);

      for (const autista of autisti) {
        await client.query(`
          INSERT INTO offerte_autisti (direttrice_id, autista_id, stato, expires_at)
          VALUES ($1, $2, 'inviata', NOW() + INTERVAL '15 minutes')
        `, [dirId, autista.id]);
      }

      const io = getIO();
      io.emit('nuova_proposta_popbus', { direttrice_id: dirId });
    }

    await client.query('COMMIT');
    console.log(`✅ [WORKER] Elaborate ${dirIds.length} nuove direttrici.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [WORKER] Errore critico:', err);
    throw err;
  } finally {
    client.release();
  }
}