import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';

/**
 * Prenota corsa con logica di segmentazione (Ridesharing Dinamico)
 * @param {Object} corsa - Dati della corsa
 * @param {string} clienteId - ID del cliente
 * @param {number} postiRichiesti - Posti desiderati
 * @param {Object} segmenti - { startIdx: number, endIdx: number } (Indici sulla polyline)
 * @param {Object} client - Connessione al database (opzionale)
 */
export async function prenotaCorsa(corsa, clienteId, postiRichiesti, segmenti, client) {
  let localClient = false;
  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    if (!corsa?.id || !postiRichiesti || !segmenti) {
      throw new Error("Parametri di prenotazione mancanti o invalidi");
    }

    // 1. VERIFICA DINAMICA (Sostituisce il FOR UPDATE su contatore statico)
    // Verifichiamo il picco di occupazione sovrapposto al segmento richiesto
    const checkRes = await client.query(
      `SELECT MAX(occupazione_segmento) as max_occ 
       FROM (
          SELECT SUM(p.posti_richiesti) as occupazione_segmento
          FROM prenotazioni p
          WHERE p.corsa_id = $1
          -- Corretto: riferimento a colonne con suffisso _polyline
          AND p.start_index_polyline < $3 AND p.end_index_polyline > $2
          GROUP BY p.start_index_polyline, p.end_index_polyline
       ) as sub`,
      [corsa.id, segmenti.startIdx, segmenti.endIdx]
    );

    const occupazioneAttuale = Number(checkRes.rows[0]?.max_occ || 0);
    
    // Verifica finale rispetto alla capacità totale del veicolo
    if ((occupazioneAttuale + postiRichiesti) > corsa.posti_totali) {
      throw new Error('Posti insufficienti: il veicolo è pieno in una porzione del tragitto richiesto');
    }

    // 2. INSERISCI PRENOTAZIONE CON SEGMENTI
    const prenRes = await client.query(
      `INSERT INTO prenotazioni (corsa_id, cliente_id, posti_richiesti, start_index_polyline, end_index_polyline) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [corsa.id, clienteId, postiRichiesti, segmenti.startIdx, segmenti.endIdx]
    );

    // 3. AGGIORNAMENTO CACHE
    // Aggiorniamo la corsa con il nuovo picco calcolato correttamente sulle colonne _polyline
    const corsaAggiornata = await client.query(
        `SELECT c.*, 
        (SELECT MAX(occ) FROM (
            SELECT SUM(posti_richiesti) as occ 
            FROM prenotazioni 
            WHERE corsa_id = $1 
            GROUP BY start_index_polyline
        ) as s) as picco_occupazione
        FROM corse c WHERE id = $1`, 
        [corsa.id]
    );
    
    CacheManager.corsa.update(corsaAggiornata.rows[0]);

    if (localClient) await client.query('COMMIT');
    return prenRes.rows[0];

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error('Errore prenotazione dinamica:', err.message);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}