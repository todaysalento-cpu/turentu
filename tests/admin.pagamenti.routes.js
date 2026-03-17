import express from 'express'
import pool from '../../db.js'

const router = express.Router()

// GET pagamenti
router.get('/', async (req,res)=>{

  try{

    const totale = await pool.query(`
      SELECT COALESCE(SUM(prezzo_totale),0) as totale
      FROM pagamenti
      WHERE stato_pagamento!='rimborsato'
    `)

    const commissioni = await pool.query(`
      SELECT COALESCE(SUM(commissione),0) as commissioni
      FROM pagamenti
      WHERE stato_pagamento='rilasciato'
    `)

    const bloccati = await pool.query(`
      SELECT COALESCE(SUM(prezzo_totale),0) as bloccati
      FROM pagamenti
      WHERE stato_pagamento='bloccato'
    `)

    const pagamenti = await pool.query(`
      SELECT 
        p.id,
        p.corsa_id,
        p.prezzo_totale,
        p.commissione,
        p.guadagno_autista,
        p.stato_pagamento,
        u.nome as cliente
      FROM pagamenti p
      JOIN utente u ON u.id = p.cliente_id
      ORDER BY p.id DESC
      LIMIT 100
    `)

    res.json({
      totale: totale.rows[0].totale,
      commissioni: commissioni.rows[0].commissioni,
      bloccati: bloccati.rows[0].bloccati,
      pagamenti: pagamenti.rows
    })

  }catch(err){

    console.error(err)

    res.status(500).json({
      error:'Errore recupero pagamenti'
    })

  }

})