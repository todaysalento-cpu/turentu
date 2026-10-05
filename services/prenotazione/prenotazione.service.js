import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';

/**
 * Prenota corsa con logica di segmentazione (Ridesharing Dinamico)
 * @param {Object} corsa - Dati della corsa
 * @param {string} clienteId - ID del cliente
 * @param {number} postiRichiesti - Posti desiderati
 * @param {Object} segmenti - { startIdx: number, endIdx: number, startOffset: number, endOffset: number, latSalita: number, lonSalita: number, latDiscesa: number, lonDiscesa: number, kmUtente: number (opzionale) }
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

    // 🔍 LOG INIZIALE DEI SEGMENTI RICEVUTI
    console.log(`📥 [PRENOTA CORSA - START] Corsa ${corsa.id} | Segmenti grezzi ricevuti:`, segmenti);

    const startIdx = Number(segmenti.startIdx ?? 0);
    const endIdx = Number(segmenti.endIdx ?? 0);
    
    // Estrazione in sicurezza dei metri di offset
    const startOffset = Number(segmenti.startOffset ?? segmenti.start_offset ?? 0);
    const endOffset = Number(segmenti.endOffset ?? segmenti.end_offset ?? 0);

    // Calcolo o recupero dei km utente per questa specifica tratta (gestendo correttamente i ritorni con Math.abs)
    const kmTotaliCorsaOriginale = Number(corsa.km_totali_percorso) || Number(corsa.km) || Number(corsa.distanza) || Number(corsa.chilometri) || 10;
    
    let kmCalc = null;
    if (startOffset >= 0 && endOffset >= 0 && startOffset !== endOffset) {
      let diffMetri = Math.abs(endOffset - startOffset);
      if (diffMetri > 1000000) diffMetri = diffMetri / 1000; // Sicurezza per eventuali metri già in km
      kmCalc = diffMetri / 1000;
    }

    const kmUtente = Number(segmenti.kmUtente ?? segmenti.km_utente) || (
      kmCalc !== null && !isNaN(kmCalc) && kmCalc > 0 
        ? Math.max(0.1, kmCalc) 
        : kmTotaliCorsaOriginale
    );

    console.log(`⚙ [PRENOTA CORSA - PARSED] Corsa ${corsa.id} -> startIdx: ${startIdx}, endIdx: ${endIdx} | startOffset: ${startOffset}m, endOffset: ${endOffset}m | kmUtente calcolato: ${kmUtente}km`);

    // 1. VERIFICA DINAMICA CORRETTA PER SOVRAPPOSIZIONE TRATTE
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
    
    if (occupazioneMassimaRilevata > corsa.posti_totali) {
      throw new Error(`Posti insufficienti: il veicolo supererebbe la capienza massima (${occupazioneMassimaRilevata}/${corsa.posti_totali}) in una porzione del tragitto richiesto.`);
    }

    // 2. INSERISCI PRENOTAZIONE CON SEGMENTI, OFFSET, KM UTENTE E COORDINATE GEOGRAFICHE
    console.log(`💾 [PRENOTA CORSA - SQL] Salvataggio nel DB con km_utente=${kmUtente}...`);

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
         km_utente,
         lat_salita,
         lon_salita,
         lat_discesa,
         lon_discesa
       ) 
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        corsa.id,                 // $1
        clienteId,                // $2
        postiRichiesti,           // $3
        startIdx,                 // $4
        endIdx,                   // $5
        startOffset,              // $6
        endOffset,                // $7
        kmUtente,                 // $8  <-- KM UTENTE CORRETTAMENTE SALVATI
        segmenti.latSalita ?? null,   // $9
        segmenti.lonSalita ?? null,   // $10
        segmenti.latDiscesa ?? null,  // $11
        segmenti.lonDiscesa ?? null   // $12
      ]
    );

    const prenotazioneInserita = prenRes.rows[0];
    console.log(`✅ [PRENOTA CORSA - SUCCESS] Prenotazione creata con ID ${prenotazioneInserita.id}. Km utente salvati: ${prenotazioneInserita.km_utente}`);

    // 🔄 2B. AGGIORNA I CONTEGGI NELLA TABELLA CORSE
    await client.query(
      `UPDATE corse 
       SET posti_prenotati = (
           SELECT COALESCE(SUM(posti_richiesti), 0) 
           FROM prenotazioni 
           WHERE corsa_id = $1
       )
       WHERE id = $1`,
      [corsa.id]
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
    return prenotazioneInserita;

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error(`❌ [ERROR] Errore prenotazione dinamica per la corsa ${corsa?.id}:`, err.message);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}