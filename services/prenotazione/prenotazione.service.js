import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';

/**
 * Prenota corsa direttamente e aggiorna la cache
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

    // 1. Blocca la riga solo per la verifica disponibilità (non tocchiamo più contatori inutili)
    const res = await client.query(
      `SELECT posti_disponibili FROM corse WHERE id=$1 FOR UPDATE`,
      [corsa.id]
    );

    if (!res.rows[0]) throw new Error(`Nessuna corsa trovata con id ${corsa.id}`);

    const { posti_disponibili } = res.rows[0];
    if (posti_disponibili < postiRichiesti) throw new Error('Posti insufficienti');

    // 2. Inserisci prenotazione (Fonte di verità)
    // Passiamo postiRichiesti per entrambi i campi per soddisfare il vincolo NOT NULL
    const prenRes = await client.query(
      `INSERT INTO prenotazioni (corsa_id, cliente_id, posti_prenotati, posti_richiesti) 
       VALUES ($1, $2, $3, $3) RETURNING *`,
      [corsa.id, clienteId, postiRichiesti]
    );

    // 3. Aggiorna SOLO la disponibilità nella tabella corse
    const updateRes = await client.query(
      `UPDATE corse
       SET posti_disponibili = posti_disponibili - $1
       WHERE id = $2
       RETURNING *, 
                 ST_Y(origine::geometry) AS origine_lat, ST_X(origine::geometry) AS origine_lon,
                 ST_Y(destinazione::geometry) AS dest_lat, ST_X(destinazione::geometry) AS dest_lon`,
      [postiRichiesti, corsa.id]
    );

    const corsaAggiornata = updateRes.rows[0];

    // 🔥 SINCRONIZZAZIONE CACHE
    CacheManager.corsa.update(corsaAggiornata);

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