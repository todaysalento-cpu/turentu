import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendNotification, getIO } from '../socket.js';
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

// -------------------- GET pending --------------------
router.get('/autista/:veicoloId', async (req, res) => {
  const client = await pool.connect();
  try {
    const veicoloId = Number(req.params.veicoloId);

    const result = await client.query(
      `SELECT p.*, u.nome AS cliente_nome
       FROM pending p
       JOIN utente u ON u.id = p.cliente_id
       WHERE p.veicolo_id = $1 AND p.stato = 'pending'
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

    const pendingRes = await client.query(
      `SELECT * FROM pending WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (!pendingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    const selectedPending = pendingRes.rows[0];

    if (selectedPending.stato !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Non disponibile' });
    }

    // 🔥 BLOCCO doppia accettazione
    if (selectedPending.request_id) {
      const alreadyAccepted = await client.query(
        `SELECT id FROM pending WHERE request_id = $1 AND stato = 'accettata' FOR UPDATE`,
        [selectedPending.request_id]
      );

      if (alreadyAccepted.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Già accettata' });
      }
    }

    // -------------------- UPDATE pending --------------------
    const result = await client.query(
      `UPDATE pending 
       SET stato = 'accettata' 
       WHERE id = $1 
       RETURNING *,
         ST_X(origine::geometry) AS origine_lon,
         ST_Y(origine::geometry) AS origine_lat,
         ST_X(destinazione::geometry) AS destinazione_lon,
         ST_Y(destinazione::geometry) AS destinazione_lat`,
      [id]
    );

    const io = getIO();
    const acceptedPendings = result.rows;

    for (const p of acceptedPendings) {
      // 🔥 PRENDO driver_id CORRETTO
      const driverRes = await client.query(
        `SELECT v.driver_id, u.nome AS driver_nome
         FROM veicolo v
         JOIN utente u ON u.id = v.driver_id
         WHERE v.id = $1`,
        [p.veicolo_id]
      );

      const driverId = driverRes.rows[0]?.driver_id;
      const driverNome = driverRes.rows[0]?.driver_nome ?? 'Autista N/D';

      let corsa, prenotazione;

      // -------------------- CREA O USA CORSA --------------------
      if (!p.corsa_id) {
        const existing = await client.query(
          `SELECT * FROM corse 
           WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
          [p.veicolo_id, p.start_datetime]
        );

        if (existing.rows.length) {
          corsa = existing.rows[0];
          prenotazione = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        } else {
          const veicolo = { id: p.veicolo_id, posti: 4 };
          const res = await createCorsaFromPending(p, veicolo, client);
          corsa = res.corsa;
          prenotazione = res.prenotazione;

          await client.query(
            `UPDATE pending SET corsa_id = $1 WHERE id = $2`,
            [corsa.id, p.id]
          );
        }
      } else {
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1`, [p.corsa_id]);
        corsa = corsaRes.rows[0];
        prenotazione = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
      }

      // -------------------- COSTRUISCO CORSA COMPLETA --------------------
      const corsaCompleta = {
        ...corsa,
        corsa_id: corsa.id,
        veicolo_id: p.veicolo_id,
        pending_id: p.id,
        origine: { lat: p.origine_lat, lon: p.origine_lon },
        destinazione: { lat: p.destinazione_lat, lon: p.destinazione_lon },
        origine_address: p.origine_address,
        destinazione_address: p.destinazione_address,
      };

      // -------------------- SOCKET AUTISTA (🔥 FIX) --------------------
      io.to(`autista_${driverId}`).emit('pending_update', {
        id: p.id,
        stato: 'accettata',
        pending_id: p.id,
        veicolo_id: p.veicolo_id,
        corsa: corsaCompleta // 🔥 QUESTO RISOLVE IL TUO BUG
      });

      io.to(`autista_${driverId}`).emit('nuova_corsa', corsaCompleta);

      // -------------------- SOCKET CLIENTE --------------------
      io.to(`cliente_${p.cliente_id}`).emit('pending_update', {
        id: p.id,
        stato: 'accettata',
        corsa_id: corsa.id,
      });

      // -------------------- NOTIFICA --------------------
      const message = `✅ Viaggio accettato da ${driverNome}`;
      const notif = await client.query(
        `INSERT INTO notifications(user_id,type,message,seen,created_at)
         VALUES ($1,'pending',$2,false,NOW()) RETURNING *`,
        [p.cliente_id, message]
      );

      sendNotification({
        userId: p.cliente_id,
        role: 'cliente',
        notification: notif.rows[0]
      });
    }

    await client.query('COMMIT');

    res.json({ ok: true });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Pending accept error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// -------------------- NEW PENDING --------------------
export async function notifyNewPending(pending) {
  try {
    const io = getIO();

    const driverRes = await pool.query(
      `SELECT driver_id FROM veicolo WHERE id = $1`,
      [pending.veicolo_id]
    );

    const driverId = driverRes.rows[0]?.driver_id;

    io.to(`autista_${driverId}`).emit('new_pending', { pending });

  } catch (err) {
    console.error('❌ notifyNewPending error:', err);
  }
}

export { router as pendingRouter };