// routes/admin/live.routes.js
import express from 'express'
import { pool } from '../../db/db.js'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    // Corse attive (in corso) - prende solo una riga per corsa (cliente principale o primo prenotato)
    const corse = await pool.query(`
      SELECT DISTINCT ON (c.id)
        c.id,
        u.nome AS cliente,
        d.nome AS autista,
        ST_Y(c.origine::geometry) AS lat,
        ST_X(c.origine::geometry) AS lng,
        c.origine_address,
        c.destinazione_address,
        c.stato
      FROM corse c
      LEFT JOIN prenotazioni pr ON pr.corsa_id = c.id
      LEFT JOIN utente u ON u.id = pr.cliente_id
      LEFT JOIN veicolo v ON v.id = c.veicolo_id
      LEFT JOIN utente d ON d.id = v.driver_id
      WHERE c.stato = 'in_corso'
      ORDER BY c.id DESC, pr.id ASC
    `)

    // Autisti online (disponibili)
    const autisti = await pool.query(`
      SELECT 
        u.id,
        u.nome,
        ST_Y(dv.coord::geometry) AS lat,
        ST_X(dv.coord::geometry) AS lng,
        v.posti_totali
      FROM veicolo v
      JOIN utente u ON u.id = v.driver_id
      JOIN disponibilita_veicolo dv ON dv.veicolo_id = v.id
      WHERE dv.start <= NOW() AND dv.fine >= NOW()
      ORDER BY u.id
    `)

    res.json({
      corse: corse.rows,
      autisti: autisti.rows
    })

  } catch (err) {
    console.error("Errore live.routes:", err)
    res.status(500).json({ error: 'Errore caricamento dati live' })
  }
})

export default router