import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { createCorsaFromDirettrice } from '../services/corsa/corsa.service.js';
import { notifyUser } from '../services/notifications/notification.service.js';

const router = express.Router();
router.use(authMiddleware);

// POST Accetta offerta PopBus
router.post('/:offerta_id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const offertaId = Number(req.params.offerta_id);
    const autistaId = req.user.id;

    await client.query('BEGIN');

    // 1. Blocco l'offerta (FOR UPDATE) e verifico che sia ancora valida
    const offertaRes = await client.query(`
      SELECT o.id, o.direttrice_id, d.stato as dir_stato
      FROM offerte_autisti o
      JOIN direttrici_virtuali d ON o.direttrice_id = d.id
      WHERE o.id = $1 AND o.stato = 'inviata' AND o.expires_at > NOW()
      FOR UPDATE`, [offertaId]);

    if (!offertaRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Offerta non disponibile o scaduta' });
    }

    const { direttrice_id } = offertaRes.rows[0];

    // 2. Transizione stato: Accetto questa, scarto le altre
    await client.query(`UPDATE offerte_autisti SET stato = 'accettata' WHERE id = $1`, [offertaId]);
    await client.query(`UPDATE offerte_autisti SET stato = 'scaduta' WHERE direttrice_id = $1 AND id != $2`, [direttrice_id, offertaId]);

    // 3. Creazione Corsa Aggregata
    const { corsa } = await createCorsaFromDirettrice(direttrice_id, autistaId, client);

    // 4. Update finale direttrice
    await client.query(`UPDATE direttrici_virtuali SET stato = 'confermata', corsa_id = $1 WHERE id = $2`, [corsa.id, direttrice_id]);

    await client.query('COMMIT');

    // 5. Notifiche (Post-Commit)
    const io = getIO();
    io.to(`autista_${autistaId}`).emit('nuova_corsa_popbus', corsa);
    
    // Notifica tutti i clienti coinvolti nella direttrice
    const { rows: clienti } = await client.query(`
      SELECT DISTINCT cliente_id FROM richieste_pop_bus 
      WHERE corsa_id = $1`, [corsa.id]);

    for (const c of clienti) {
      await notifyUser(c.cliente_id, {
        type: 'popbus',
        message: 'La tua corsa PopBus è stata confermata da un autista!',
        data: { corsaId: corsa.id }
      });
    }

    res.json({ ok: true, corsa_id: corsa.id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Errore accetta PopBus:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as popbusRouter };