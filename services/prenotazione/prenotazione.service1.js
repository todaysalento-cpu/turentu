import { pool } from '../../db/db.js';

/**
 * Prenota corsa direttamente
 * @param {object} corsa - la corsa da prenotare (deve avere id e tipo_corsa)
 * @param {number} clienteId - id del cliente che prenota
 * @param {number} postiRichiesti - numero di posti richiesti
 * @param {object} client - opzionale, client per transazione esterna
 * @returns {object} prenotazione creata
 */
export async function prenotaCorsa(corsa, clienteId, postiRichiesti, client) {
  let localClient = false;

  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    if (!corsa || !corsa.id) throw new Error("Oggetto corsa non valido o manca id");
    if (!corsa.tipo_corsa) throw new Error("La corsa deve avere il campo tipo_corsa valorizzato");
    if (!postiRichiesti || postiRichiesti <= 0) throw new Error("Il numero di posti richiesti deve essere maggiore di 0");

    // Blocca la riga della corsa per evitare race condition
    const res = await client.query(
      `SELECT posti_disponibili, posti_prenotati, posti_totali
       FROM corse
       WHERE id=$1
       FOR UPDATE`,
      [corsa.id]
    );

    if (!res.rows[0]) throw new Error(`Nessuna corsa trovata con id ${corsa.id}`);

    const { posti_disponibili, posti_prenotati = 0, posti_totali } = res.rows[0];
    if (posti_disponibili < postiRichiesti) throw new Error('Posti insufficienti');

    // Aggiorna posti disponibili e prenotati
    await client.query(
      `UPDATE corse
       SET posti_disponibili = posti_disponibili - $1,
           posti_prenotati = posti_prenotati + $1
       WHERE id = $2`,
      [postiRichiesti, corsa.id]
    );

    // Inserisci prenotazione
    const prenRes = await client.query(
      `INSERT INTO prenotazioni 
        (corsa_id, cliente_id, posti_prenotati, posti_richiesti) 
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [corsa.id, clienteId, postiRichiesti, postiRichiesti]
    );

    if (localClient) await client.query('COMMIT');

    return prenRes.rows[0];

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error('Errore prenotazione corsa:', err.message);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}
