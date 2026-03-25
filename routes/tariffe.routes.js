// ======================= routes/tariffe.routes.ts =======================
import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Tutte le rotte richiedono login
router.use(authMiddleware);

// -------------------- GET tariffe per veicolo --------------------
router.get('/veicolo/:id', async (req, res) => {
  try {
    const veicoloId = Number(req.params.id);
    const result = await pool.query(
      `SELECT 
          id,
          veicolo_id,
          tipo,
          euro_km::float AS euro_km,
          prezzo_passeggero::float AS prezzo_passeggero,
          giorno_settimana,
          ora_inizio,
          ora_fine,
          created_at,
          updated_at
       FROM tariffe 
       WHERE veicolo_id=$1 
       ORDER BY tipo, giorno_settimana, ora_inizio`,
      [veicoloId]
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('❌ Fetch tariffe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST nuova tariffa o update se esiste --------------------
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Accetta sia un singolo oggetto che un array di tariffe
    const tariffeArray = Array.isArray(body) ? body : [body];

    if (tariffeArray.some(t => !t.veicolo_id)) {
      return res.status(400).json({ error: 'veicolo_id mancante in una o più tariffe' });
    }

    const results = [];

    for (const t of tariffeArray) {
      const {
        veicolo_id,
        tipo = 'standard',
        euro_km = 1,
        prezzo_passeggero = 0,
        giorno_settimana,
        ora_inizio,
        ora_fine
      } = t;

      console.log('💾 Inserendo/aggiornando tariffa:', t);

      const result = await pool.query(
        `INSERT INTO tariffe
          (veicolo_id, tipo, euro_km, prezzo_passeggero, giorno_settimana, ora_inizio, ora_fine)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (veicolo_id, tipo) DO UPDATE SET
           euro_km = EXCLUDED.euro_km,
           prezzo_passeggero = EXCLUDED.prezzo_passeggero,
           giorno_settimana = EXCLUDED.giorno_settimana,
           ora_inizio = EXCLUDED.ora_inizio,
           ora_fine = EXCLUDED.ora_fine,
           updated_at = NOW()
         RETURNING 
           id,
           veicolo_id,
           tipo,
           euro_km::float AS euro_km,
           prezzo_passeggero::float AS prezzo_passeggero,
           giorno_settimana,
           ora_inizio,
           ora_fine,
           created_at,
           updated_at`,
        [veicolo_id, tipo, euro_km, prezzo_passeggero, giorno_settimana, ora_inizio, ora_fine]
      );

      results.push(result.rows[0]);
    }

    res.status(201).json(results);
  } catch (err) {
    console.error('❌ Insert/Update tariffa error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- PUT aggiorna tariffa --------------------
router.put('/:id', async (req, res) => {
  try {
    const tariffaId = Number(req.params.id);
    const {
      tipo,
      euro_km,
      prezzo_passeggero,
      giorno_settimana,
      ora_inizio,
      ora_fine
    } = req.body;

    const result = await pool.query(
      `UPDATE tariffe SET
        tipo=$1,
        euro_km=$2,
        prezzo_passeggero=$3,
        giorno_settimana=$4,
        ora_inizio=$5,
        ora_fine=$6,
        updated_at=NOW()
       WHERE id=$7
       RETURNING 
         id,
         veicolo_id,
         tipo,
         euro_km::float AS euro_km,
         prezzo_passeggero::float AS prezzo_passeggero,
         giorno_settimana,
         ora_inizio,
         ora_fine,
         created_at,
         updated_at`,
      [tipo, euro_km, prezzo_passeggero, giorno_settimana, ora_inizio, ora_fine, tariffaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tariffa non trovata' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('❌ Update tariffa error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- DELETE tariffa --------------------
router.delete('/:id', async (req, res) => {
  try {
    const tariffaId = Number(req.params.id);
    const result = await pool.query('DELETE FROM tariffe WHERE id=$1 RETURNING *', [tariffaId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tariffa non trovata' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Delete tariffa error:', err);
    res.status(500).json({ error: err.message });
  }
});

export { router as tariffeRouter };