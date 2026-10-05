import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';

/**
 * Prenota corsa con logica di segmentazione (Ridesharing Dinamico)
 * @param {Object} corsa - Dati della corsa
 * @param {string} clienteId - ID del cliente
 * @param {number} postiRichiesti - Posti desiderati
 * @param {Object} segmenti - { startIdx: number, endIdx: number, startOffset: number, endOffset: number, latSalita: number, lonSalita: number, latDiscesa: number, lonDiscesa: number }
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

    const startIdx = Number(segmenti.startIdx ?? 0);
    const endIdx = Number(segmenti.endIdx ?? 0);
    
    // Estrazione in sicurezza dei metri di offset (con fallback a 0 o valori stimati)
    const startOffset = Number(segmenti.startOffset ?? segmenti.start_offset ?? 0);
    const endOffset = Number(segmenti.endOffset ?? segmenti.end_offset ?? 0);

    // 1. VERIFICA DINAMICA CORRETTA PER SOVRAPPOSIZIONE TRATTE (Event-based / Sweep-line o controllo intervalli)
    // Controlla il picco di occupazione sovrapponendo l'intervallo [startIdx, endIdx] con le prenotazioni esistenti.
    const checkRes = await client.query(
      `SELECT COALESCE(MAX(occupazione_totale), 0) as max_occ FROM (
         SELECT 
           p.id::text as id,
           (
             SELECT SUM(p2.posti_richiesti)
             FROM prenotazioni p2
             WHERE p2.corsa_id = $1
               AND p2.start_index_polyline < p.end_index_polyline
               AND p2.end_index_polyline > p.start_index_polyline
           ) as occupazione_totale
         FROM prenotazioni p
         WHERE p.corsa_id = $1
         
         UNION
         
         -- Aggiungiamo anche un punto di controllo virtuale per la nuova prenotazione richiesta
         SELECT 
           'nuova'::text as id,
           (
             SELECT SUM(p2.posti_richiesti) + $4
             FROM prenotazioni p2
             WHERE p2.corsa_id = $1
               AND p2.start_index_polyline < $3
               AND p2.end_index_polyline > $2
           ) as occupazione_totale
      ) sub`,
      [corsa.id, startIdx, endIdx, postiRichiesti]
    );

    const occupazioneMassimaRilevata = Number(checkRes.rows[0]?.max_occ || 0);
    
    // Verifica finale rispetto alla capacità totale del veicolo
    if (occupazioneMassimaRilevata > corsa.posti_totali) {
      throw new Error(`Posti insufficienti: il veicolo supererebbe la capienza massima (${occupazioneMassimaRilevata}/${corsa.posti_totali}) in una porzione del tragitto richiesto.`);
    }

    // 2. INSERISCI PRENOTAZIONE CON SEGMENTI, OFFSET E COORDINATE GEOGRAFICHE
    const prenRes = await client.query(
      `INSERT INTO prenotazioni (
          corsa_id, 
          cliente_id, 
          posti_richiesti, 
          posti_prenotati, 
          start_index_polyline, 
          end_index_polyline,
          start_offset,
          end_offset,
          lat_salita,
          lon_salita,
          lat_discesa,
          lon_discesa
       ) 
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        corsa.id,                     // $1
        clienteId,                    // $2
        postiRichiesti,               // $3
        startIdx,                     // $4
        endIdx,                       // $5
        startOffset,                  // $6
        endOffset,                    // $7
        segmenti.latSalita ?? null,   // $8
        segmenti.lonSalita ?? null,   // $9
        segmenti.latDiscesa ?? null,  // $10
        segmenti.lonDiscesa ?? null   // $11
      ]
    );

    // 3. AGGIORNAMENTO CACHE
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