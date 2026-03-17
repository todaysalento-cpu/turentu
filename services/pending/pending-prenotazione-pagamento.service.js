import { pool } from '../../db/db.js';
import * as pendingService from '../pending/pending.service.js';
import { createCorsaFromPending } from '../corsa/corsa.service.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import * as pagamentoService from '../pagamento/pagamento.service.js';

/**
 * Booking engine unico:
 * - prenotazione diretta (corsa compatibile)
 * - pending (corsa non compatibile)
 * - gestione corsa + prenotazione + pagamento
 */
export async function processBooking({
  corsa = null,
  pendingId = null,
  clienteId,
  postiRichiesti,
  importo,
  currency = 'eur'
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let corsaFinale;
    let prenotazione;
    let tipoCorsa;

    // =====================================================
    // 🧠 CASO 1 — PRENOTAZIONE DIRETTA (corsa compatibile)
    // =====================================================
    if (corsa?.id) {
      tipoCorsa = corsa.tipo_corsa;

      prenotazione = await prenotazioneService.prenotaCorsa(
        corsa,
        clienteId,
        postiRichiesti,
        client
      );

      corsaFinale = corsa;
    }

    // =====================================================
    // 🧠 CASO 2 — PENDING
    // =====================================================
    if (!corsa && pendingId) {
      const pending = await pendingService.getPendingById(pendingId, client);
      if (!pending) throw new Error(`Pending ${pendingId} non trovato`);

      tipoCorsa = pending.tipo_corsa;

      // Lock su eventuale corsa identica
      const res = await client.query(
        `SELECT * FROM corse
         WHERE veicolo_id = $1
           AND start_datetime = $2
           AND stato IN ('prenotabile','in_progress')
         FOR UPDATE`,
        [pending.veicolo_id, pending.start_datetime]
      );

      // 🆕 Nessuna corsa → crea corsa + prenotazione
      if (res.rows.length === 0) {
        const veicoloRes = await client.query(
          `SELECT * FROM veicolo WHERE id = $1`,
          [pending.veicolo_id]
        );
        const veicolo = veicoloRes.rows[0];

        const result = await createCorsaFromPending(pending, veicolo, client);
        corsaFinale = result.corsa;
        prenotazione = result.prenotazione;
      } 
      // 🚫 Slot occupato + privata
      else if (pending.tipo_corsa === 'privata') {
        await pendingService.updatePendingStatus(pending.id, 'rejected', client);
        await client.query('COMMIT');
        return { stato: 'rejected', motivo: 'Slot occupato per corsa privata' };
      }
      // 🤝 Slot occupato + condivisa
      else {
        corsaFinale = res.rows[0];
        prenotazione = await prenotazioneService.prenotaCorsa(
          corsaFinale,
          pending.cliente_id,
          pending.posti_richiesti,
          client
        );
      }

      await pendingService.updatePendingStatus(pending.id, 'processed', client);
    }

    if (!prenotazione) {
      throw new Error('Nessuna prenotazione creata');
    }

    // =====================================================
    // 💳 PAGAMENTO (sempre una sola volta)
    // =====================================================
    const pagamento = await pagamentoService.creaPagamento(
      prenotazione.id,
      tipoCorsa,
      importo,
      currency,
      client
    );

    await client.query('COMMIT');

    return {
      corsa: corsaFinale,
      prenotazione,
      pagamento
    };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Booking engine error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}
