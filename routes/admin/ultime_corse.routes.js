// routes/admin/ultime_corse.routes.js
import express from 'express'
import { pool } from '../../db/db.js'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const corse = await pool.query(`
      SELECT 
        c.id,
        STRING_AGG(u.nome, ', ') AS clienti,  -- concatena tutti i clienti della corsa
        d.nome AS autista,
        c.prezzo_fisso AS prezzo,
        c.stato,
        c.created_at
      FROM corse c
      LEFT JOIN prenotazioni pr ON pr.corsa_id = c.id
      LEFT JOIN utente u ON u.id = pr.cliente_id
      LEFT JOIN veicolo v ON v.id = c.veicolo_id
      LEFT JOIN utente d ON d.id = v.driver_id
      GROUP BY c.id, d.nome, c.prezzo_fisso, c.stato, c.created_at
      ORDER BY c.created_at DESC
      LIMIT 10
    `)

    res.json(corse.rows)
  } catch (err) {
    console.error("Errore ultime_corse.routes:", err)
    res.status(500).json({ error: 'Errore ultime corse' })
  }
})

export default router