import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const types = new Set(['standard', 'notturna', 'festivo']);
const ownVehicle = async (client, vehicleId, userId) => {
  const { rowCount } = await client.query('SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2', [vehicleId, userId]);
  return rowCount > 0;
};
const tariffColumns = `id, veicolo_id, tipo, euro_km::float AS euro_km,
 prezzo_passeggero::float AS prezzo_passeggero, giorno_settimana,
 ora_inizio, ora_fine, created_at, updated_at`;

router.get('/veicolo/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!validId(id)) return res.status(400).json({ error: 'Veicolo non valido' });
  try {
    if (!(await ownVehicle(pool, id, req.user.id))) return res.status(404).json({ error: 'Veicolo non trovato' });
    const { rows } = await pool.query(`SELECT ${tariffColumns} FROM tariffe WHERE veicolo_id=$1 ORDER BY tipo, giorno_settimana, ora_inizio`, [id]);
    return res.json(rows);
  } catch (err) { console.error('GET tariffe:', err); return res.status(500).json({ error: 'Errore interno' }); }
});

router.post('/', async (req, res) => {
  const entries = Array.isArray(req.body) ? req.body : [req.body];
  if (!entries.length || entries.some(t => !t || !validId(t.veicolo_id) || !types.has(t.tipo) ||
      t.euro_km === '' || t.euro_km == null || t.prezzo_passeggero === '' || t.prezzo_passeggero == null ||
      !Number.isFinite(Number(t.euro_km)) || Number(t.euro_km) < 0 ||
      !Number.isFinite(Number(t.prezzo_passeggero)) || Number(t.prezzo_passeggero) < 0)) {
    return res.status(400).json({ error: 'Dati tariffari non validi' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vehicleIds = [...new Set(entries.map(t => Number(t.veicolo_id)))];
    for (const id of vehicleIds) {
      if (!(await ownVehicle(client, id, req.user.id))) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Veicolo non trovato' });
      }
    }
    const rows = [];
    for (const t of entries) {
      const result = await client.query(`INSERT INTO tariffe
        (veicolo_id,tipo,euro_km,prezzo_passeggero,giorno_settimana,ora_inizio,ora_fine)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (veicolo_id,tipo) DO UPDATE SET
        euro_km=EXCLUDED.euro_km, prezzo_passeggero=EXCLUDED.prezzo_passeggero,
        giorno_settimana=EXCLUDED.giorno_settimana, ora_inizio=EXCLUDED.ora_inizio,
        ora_fine=EXCLUDED.ora_fine, updated_at=NOW()
        RETURNING ${tariffColumns}`,
        [Number(t.veicolo_id),t.tipo,Number(t.euro_km),Number(t.prezzo_passeggero),
         t.giorno_settimana ?? null,t.ora_inizio ?? null,t.ora_fine ?? null]);
      rows.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return res.status(201).json(rows);
  } catch (err) {
    await client.query('ROLLBACK'); console.error('POST tariffe:', err);
    return res.status(500).json({ error: 'Errore interno' });
  } finally { client.release(); }
});

router.put('/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Tariffa non valida' });
  const t = req.body;
  if (!t || !types.has(t.tipo) || t.euro_km == null || t.euro_km === '' ||
      t.prezzo_passeggero == null || t.prezzo_passeggero === '' ||
      !Number.isFinite(Number(t.euro_km)) || Number(t.euro_km) < 0 ||
      !Number.isFinite(Number(t.prezzo_passeggero)) || Number(t.prezzo_passeggero) < 0) {
    return res.status(400).json({ error: 'Dati tariffari non validi' });
  }
  try {
    const { rows } = await pool.query(`UPDATE tariffe AS t SET tipo=$1, euro_km=$2,
      prezzo_passeggero=$3, giorno_settimana=$4, ora_inizio=$5, ora_fine=$6, updated_at=NOW()
      FROM veicolo AS v WHERE t.id=$7 AND t.veicolo_id=v.id AND v.driver_id=$8
      RETURNING t.id, t.veicolo_id, t.tipo, t.euro_km::float AS euro_km,
      t.prezzo_passeggero::float AS prezzo_passeggero, t.giorno_settimana,
      t.ora_inizio, t.ora_fine, t.created_at, t.updated_at`,
      [t.tipo,Number(t.euro_km),Number(t.prezzo_passeggero),t.giorno_settimana ?? null,
       t.ora_inizio ?? null,t.ora_fine ?? null,Number(req.params.id),req.user.id]);
    return rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'Tariffa non trovata' });
  } catch (err) { console.error('PUT tariffe:', err); return res.status(500).json({ error: 'Errore interno' }); }
});

router.delete('/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Tariffa non valida' });
  try {
    const { rowCount } = await pool.query(`DELETE FROM tariffe AS t USING veicolo AS v
      WHERE t.id=$1 AND t.veicolo_id=v.id AND v.driver_id=$2`, [Number(req.params.id),req.user.id]);
    return rowCount ? res.json({ success: true }) : res.status(404).json({ error: 'Tariffa non trovata' });
  } catch (err) { console.error('DELETE tariffe:', err); return res.status(500).json({ error: 'Errore interno' }); }
});

export { router as tariffeRouter };
