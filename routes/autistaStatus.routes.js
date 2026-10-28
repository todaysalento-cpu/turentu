// routes/autistaStatus.routes.js
import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.get('/status', authMiddleware, async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Utente non autenticato' });

  try {
    const userId = req.user.id;
    // Una singola fotografia consistente: preferisce un veicolo con disponibilita e tariffe.
    const [profileResult, vehicleResult] = await Promise.all([
      pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1 ORDER BY id DESC LIMIT 1', [userId]),
      pool.query(`
        SELECT v.* FROM veicolo v
        WHERE v.driver_id = $1
        ORDER BY
          (EXISTS (SELECT 1 FROM disponibilita_veicolo d WHERE d.veicolo_id = v.id)
           AND EXISTS (SELECT 1 FROM tariffe t WHERE t.veicolo_id = v.id)) DESC,
          v.id DESC
        LIMIT 1
      `, [userId])
    ]);

    const profilo = profileResult.rows[0] ?? null;
    const veicolo = vehicleResult.rows[0] ?? null;
    let disponibilita = null;
    let tariffe = [];

    if (veicolo) {
      const [availabilityResult, tariffResult] = await Promise.all([
        pool.query('SELECT * FROM disponibilita_veicolo WHERE veicolo_id = $1 LIMIT 1', [veicolo.id]),
        pool.query('SELECT * FROM tariffe WHERE veicolo_id = $1', [veicolo.id])
      ]);
      disponibilita = availabilityResult.rows[0] ?? null;
      tariffe = tariffResult.rows;
    }

    const completo = Boolean(profilo && veicolo && disponibilita && tariffe.length > 0);
    console.log('[STATUS_CHECK]', { userId, veicoloId: veicolo?.id ?? null, completo });
    return res.json({ profilo, veicolo, disponibilita, tariffe, completo });
  } catch (err) {
    console.error('[STATUS_CHECK] Errore verifica onboarding:', err);
    // Mai restituire dati vuoti con HTTP 200 in caso di errore SQL.
    return res.status(500).json({ error: 'Impossibile verificare lo stato onboarding' });
  }
});

export default router;
