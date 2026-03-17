// ======================= booking-engine.js =======================
import { pool } from '../../db/db.js';
import * as pendingService from '../pending/pending.service.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../corsa/corsa.service.js';

/**
 * Booking Engine con conferma pagamento-first
 * @param {Object} params
 * @param {'prenota'|'richiedi'} params.action
 * @param {Object} [params.corsa] - richiesta prenotazione diretta
 * @param {number} [params.clienteId]
 * @param {number} [params.posti_richiesti]
 * @param {number} [params.pendingId] - necessario per richiedi
 */
export async function processBookingAfterPayment({ action, corsa, clienteId, posti_richiesti, pendingId }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (action === 'prenota') {
      if (!corsa) throw new Error('Corsa richiesta per prenotazione diretta');
      if (!corsa.tipo_corsa) throw new Error('La corsa deve avere il campo tipo_corsa valorizzato');

      // ✅ Crea prenotazione SOLO dopo conferma pagamento
      const prenotazione = await prenotazioneService.prenotaCorsa(corsa, clienteId, posti_richiesti, client);

      await client.query('COMMIT');
      return { prenotazione };

    } else if (action === 'richiedi') {
      if (!pendingId) throw new Error('pendingId necessario per azione richiedi');

      const pending = await pendingService.getPendingById(pendingId, client);
      if (!pending) throw new Error(`Pending ${pendingId} non trovato`);

      // Ottieni veicolo associato al pending
      const veicoloRes = await client.query(`SELECT * FROM veicolo WHERE id=$1`, [pending.veicolo_id]);
      const veicolo = veicoloRes.rows[0];

      // ✅ Crea corsa e prenotazione SOLO dopo conferma pagamento
      const { corsa: corsaFinale, prenotazione } = await createCorsaFromPending(pending, veicolo, client);

      // ✅ Aggiorna stato pending a processed
      await pendingService.updatePendingStatus(pending.id, 'processed', client);

      await client.query('COMMIT');
      return { corsa: corsaFinale, prenotazione };

    } else {
      throw new Error('Azione non valida: deve essere prenota o richiedi');
    }

  } catch (err) {
    await client.query('ROLLBACK'); // rollback completo
    console.error('❌ Booking engine (post-payment) error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

export default { processBookingAfterPayment };
