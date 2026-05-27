import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendNotification, getIO } from '../socket.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const router = express.Router();
router.use(authMiddleware);

router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  const notificheDaInviare = [];

  try {
    const id = Number(req.params.id);
    await client.query('BEGIN');

    const pendingRes = await client.query(`SELECT * FROM pending WHERE id = $1 FOR UPDATE`, [id]);
    if (!pendingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    const p = pendingRes.rows[0];
    if (p.stato !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Non disponibile' });
    }

    const result = await client.query(
      `UPDATE pending SET stato = 'accettata' WHERE id = $1 
       RETURNING *, ST_X(origine::geometry) AS origine_lon, ST_Y(origine::geometry) AS origine_lat,
       ST_X(destinazione::geometry) AS destinazione_lon, ST_Y(destinazione::geometry) AS destinazione_lat`,
      [id]
    );

    for (const p of result.rows) {
      let corsa;
      // 1. Logica Corsa
      if (!p.corsa_id) {
        const existing = await client.query(
          `SELECT * FROM corse WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
          [p.veicolo_id, p.start_datetime]
        );
        if (existing.rows.length) {
          corsa = existing.rows[0];
          await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        } else {
          const vRes = await client.query('SELECT posti_totali FROM veicolo WHERE id = $1', [p.veicolo_id]);
          const resCorsa = await createCorsaFromPending(p, { id: p.veicolo_id, posti: vRes.rows[0]?.posti_totali ?? 4 }, client);
          corsa = resCorsa.corsa;
          await client.query(`UPDATE pending SET corsa_id = $1 WHERE id = $2`, [corsa.id, p.id]);
        }
      } else {
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1`, [p.corsa_id]);
        corsa = corsaRes.rows[0];
        await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
      }

      // 2. Recupero ID Prenotazione per soddisfare la Foreign Key
      const prenotazioneRes = await client.query(
        `SELECT id FROM prenotazioni WHERE cliente_id = $1 AND corsa_id = $2 ORDER BY id DESC LIMIT 1`,
        [p.cliente_id, corsa.id]
      );
      const prenotazioneId = prenotazioneRes.rows[0]?.id;

      // 3. Inserimento Pagamento sicuro
      if (p.payment_intent_id && prenotazioneId) {
        await client.query(
          `INSERT INTO pagamenti (prenotazione_id, importo, stato, stripe_payment_intent, corsa_id, updated_at)
           VALUES ($1, $2, 'autorizzazione', $3, $4, NOW())
           ON CONFLICT (stripe_payment_intent) DO UPDATE 
           SET prenotazione_id = EXCLUDED.prenotazione_id, corsa_id = EXCLUDED.corsa_id`,
          [prenotazioneId, p.prezzo, p.payment_intent_id, corsa.id]
        );
      }

      // Notifiche...
      const driverRes = await client.query(`SELECT v.driver_id, u.nome AS driver_nome FROM veicolo v JOIN utente u ON u.id = v.driver_id WHERE v.id = $1`, [p.veicolo_id]);
      notificheDaInviare.push({ p, corsa, driverId: driverRes.rows[0]?.driver_id, driverNome: driverRes.rows[0]?.driver_nome });
    }

    await client.query('COMMIT');
    // ... invio notifiche ...
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as pendingRouter };