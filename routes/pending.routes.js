import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendNotification, getIO } from '../socket.js'; // ✅ nuovo import
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const router = express.Router();
router.use(authMiddleware);

// -------------------- Helper notifiche --------------------
function formatNotificationDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const isToday = d.toDateString() === today.toDateString();
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayName = d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'long' });

  if (isToday) return `oggi alle ${time}`;
  if (isTomorrow) return `domani alle ${time}`;
  return `${dayName} all’${time}`;
}

// -------------------- GET pending di un veicolo --------------------
router.get('/autista/:veicoloId', async (req, res) => {
  const client = await pool.connect();
  try {
    const veicoloId = Number(req.params.veicoloId);

    const result = await client.query(
      `SELECT p.*, u.nome AS cliente_nome
       FROM pending p
       JOIN utente u ON u.id = p.cliente_id
       WHERE p.veicolo_id = $1 
       AND p.stato = 'pending'
       ORDER BY p.id ASC`,
      [veicoloId]
    );

    const pendings = result.rows.map(p => ({
      ...p,
      cliente: p.cliente_nome || 'Cliente N/D',
      prezzo: Number(p.prezzo ?? 0),
    }));

    res.json({ pendings });
  } catch (err) {
    console.error('❌ Error fetching pendings:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// -------------------- POST accetta pending --------------------
router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    await client.query('BEGIN');

    const pendingRes = await client.query(`SELECT * FROM pending WHERE id = $1 FOR UPDATE`, [id]);
    if (!pendingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    const selectedPending = pendingRes.rows[0];

    if (selectedPending.stato !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Questa richiesta non è più disponibile' });
    }

    if (selectedPending.request_id) {
      const alreadyAccepted = await client.query(
        `SELECT id FROM pending WHERE request_id = $1 AND stato = 'accettata' FOR UPDATE`,
        [selectedPending.request_id]
      );
      if (alreadyAccepted.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Richiesta già accettata da un altro autista' });
      }
    }

    const returningFields = `
      *, 
      ST_X(origine::geometry) AS origine_lon, 
      ST_Y(origine::geometry) AS origine_lat,
      ST_X(destinazione::geometry) AS destinazione_lon, 
      ST_Y(destinazione::geometry) AS destinazione_lat,
      origine_address, destinazione_address, payment_intent_id, distanza
    `;

    const result = await client.query(
      `UPDATE pending SET stato = 'accettata' WHERE id = $1 RETURNING ${returningFields}`,
      [id]
    );

    let acceptedPendings = result.rows;

    if (selectedPending.request_id) {
      await client.query(
        `UPDATE pending SET stato = 'rifiutata' WHERE request_id = $1 AND id <> $2`,
        [selectedPending.request_id, id]
      );
    }

    acceptedPendings = acceptedPendings.map(p => ({
      ...p,
      origine: { lat: p.origine_lat ?? null, lon: p.origine_lon ?? null },
      destinazione: { lat: p.destinazione_lat ?? null, lon: p.destinazione_lon ?? null },
      origine_address: p.origine_address || 'N/D',
      destinazione_address: p.destinazione_address || 'N/D',
      prezzo: Number(p.prezzo ?? 0),
      distanza: p.distanza !== null ? Number(p.distanza) : null,
    }));

    let prenotazioni = [];
    const io = getIO(); // ✅ socket globale

    for (const p of acceptedPendings) {
      let corsa, prenotazione;

      const driverRes = await client.query(
        `SELECT u.nome AS driver_nome FROM veicolo v JOIN utente u ON u.id = v.driver_id WHERE v.id = $1`,
        [p.veicolo_id]
      );
      const driverNome = driverRes.rows[0]?.driver_nome ?? 'Autista N/D';

      if (!p.corsa_id) {
        const existingCorsa = await client.query(
          `SELECT * FROM corse WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
          [p.veicolo_id, p.start_datetime]
        );

        if (existingCorsa.rows.length) {
          corsa = existingCorsa.rows[0];
          prenotazione = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        } else {
          const veicolo = { id: p.veicolo_id, posti: 4 };
          const corsaResult = await createCorsaFromPending({ ...p, distanza: p.distanza }, veicolo, client);
          corsa = corsaResult.corsa;
          prenotazione = corsaResult.prenotazione;
          await client.query(`UPDATE pending SET corsa_id = $1 WHERE id = $2`, [corsa.id, p.id]);
        }
        p.corsa_id = corsa.id;
        prenotazioni.push(prenotazione);
      } else {
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1`, [p.corsa_id]);
        if (!corsaRes.rows.length) throw new Error('Corsa non trovata');
        corsa = corsaRes.rows[0];
        prenotazione = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        prenotazioni.push(prenotazione);
      }

      if (p.payment_intent_id) {
        await client.query(
          `INSERT INTO pagamenti (prenotazione_id, stripe_payment_intent, importo, stato, updated_at)
           VALUES ($1,$2,$3,'autorizzazione',NOW())`,
          [prenotazione.id, p.payment_intent_id, p.prezzo]
        );
      }

      const messageCliente = `✅ Il tuo viaggio da ${p.origine_address} a ${p.destinazione_address} è stato accettato da ${driverNome}.\nPrezzo: €${p.prezzo.toFixed(2)}`;

      const notifClienteRes = await client.query(
        `INSERT INTO notifications(user_id, type, message, seen, created_at)
         VALUES ($1,'pending',$2,false,NOW()) RETURNING *`,
        [p.cliente_id, messageCliente]
      );

      const notifCliente = notifClienteRes.rows[0];
      notifCliente.displayDate = formatNotificationDate(new Date(notifCliente.created_at));

      sendNotification({ userId: p.cliente_id, role: 'cliente', notification: notifCliente });

      // ✅ Emit tramite io globale
      io.to(`cliente_${p.cliente_id}`).emit('pending_update', {
        id: p.id,
        corsa_id: p.corsa_id,
        stato: 'accettata',
        driver_nome: driverNome
      });
      io.to(`autista_${p.veicolo_id}`).emit('nuova_corsa', corsa);
    }

    await client.query('COMMIT');
    res.json({ pendings: acceptedPendings, prenotazioni });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Pending accept error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// -------------------- Helper real-time nuova pending --------------------
export async function notifyNewPending(pending) {
  try {
    const io = getIO();
    const message = `🚖 Nuova richiesta da ${pending.cliente_nome} da ${pending.origine_address} a ${pending.destinazione_address}`;
    io.to(`autista_${pending.veicolo_id}`).emit('new_pending', { pending, message });
  } catch (err) {
    console.error('❌ Errore notifyNewPending:', err);
  }
}

export { router as pendingRouter };