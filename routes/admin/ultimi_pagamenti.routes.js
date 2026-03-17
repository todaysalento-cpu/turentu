import express from 'express'
import { pool } from '../../db/db.js';

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const pagamenti = await pool.query(`
      SELECT 
        p.id,
        u.nome AS cliente,
        pr.prezzo_totale,
        p.commissione,
        p.guadagno_autista,
        p.stato AS stato_pagamento,
        p.updated_at AS created_at
      FROM pagamenti p
      JOIN prenotazioni pr ON pr.id = p.prenotazione_id
      JOIN utente u ON u.id = pr.cliente_id
      ORDER BY p.updated_at DESC
      LIMIT 10
    `)

    res.json(pagamenti.rows)
  } catch (err) {
    console.error("Errore ultimi pagamenti:", err)
    res.status(500).json({ error: 'Errore ultimi pagamenti' })
  }
})

export default router