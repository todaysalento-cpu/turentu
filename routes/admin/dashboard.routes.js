import express from 'express';
import { pool } from '../../db/db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // ===================== KPI principali =====================
    const query = `
      WITH
      clienti AS (
        SELECT COUNT(*) AS totale
        FROM utente
        WHERE LOWER(TRIM(tipo)) = 'cliente'
      ),
      autisti AS (
        SELECT COUNT(*) AS totale
        FROM utente
        WHERE LOWER(TRIM(tipo)) = 'autista'
      ),
      veicoli AS (
        SELECT COUNT(*) AS totale FROM veicolo
      ),
      veicoli_disponibili AS (
        SELECT COUNT(*) AS totale
        FROM veicolo v
        JOIN disponibilita_veicolo dv ON dv.veicolo_id = v.id
        WHERE dv.start <= NOW() AND dv.fine >= NOW()
      ),
      corse_totali AS (
        SELECT COUNT(*) AS totale FROM corse
      ),
      corse_oggi AS (
        SELECT COUNT(*) AS totale
        FROM corse
        WHERE DATE(created_at) = CURRENT_DATE
      ),
      fatturato AS (
        SELECT COALESCE(SUM(prezzo_fisso)::numeric(20,2),0) AS totale
        FROM corse
        WHERE stato = 'completata'
      ),
      guadagno AS (
        SELECT COALESCE(SUM(guadagno_autista)::numeric(20,2),0) AS totale
        FROM pagamenti
        WHERE stato='rilasciato'
      )
      SELECT 
        (SELECT totale FROM clienti) AS clienti,
        (SELECT totale FROM autisti) AS autisti,
        (SELECT totale FROM veicoli) AS veicoli,
        (SELECT totale FROM veicoli_disponibili) AS veicoli_disponibili,
        (SELECT totale FROM corse_totali) AS corse_totali,
        (SELECT totale FROM corse_oggi) AS corse_oggi,
        (SELECT totale FROM fatturato) AS fatturato,
        (SELECT totale FROM guadagno) AS guadagno
    `;

    // ===================== Parallel fetch =====================
    const [
      mainRes,
      crescitaRes,
      topAutistiRes,
      corseLiveRes,
      autistiLiveRes
    ] = await Promise.all([
      pool.query(query),
      pool.query(`
        SELECT DATE(updated_at) AS giorno,
               COALESCE(SUM(importo)::numeric(20,2),0) AS ricavi
        FROM pagamenti
        WHERE stato='rilasciato' AND updated_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY giorno
        ORDER BY giorno
      `),
      pool.query(`
        SELECT u.nome,
               COUNT(c.id) AS corse,
               COALESCE(SUM(p.guadagno_autista)::numeric(20,2),0) AS guadagno
        FROM pagamenti p
        LEFT JOIN corse c ON c.id = p.corsa_id
        LEFT JOIN veicolo v ON v.id = c.veicolo_id
        LEFT JOIN utente u ON u.id = v.driver_id
        WHERE p.stato='rilasciato'
        GROUP BY u.nome
        ORDER BY guadagno DESC
        LIMIT 5
      `),
      // ===================== Corse live =====================
      pool.query(`
        SELECT c.id,
               cl.nome AS cliente,
               a.nome AS autista,
               c.prezzo_fisso AS prezzo,
               c.stato,
               ST_Y(c.origine::geometry) AS lat,
               ST_X(c.origine::geometry) AS lng
        FROM corse c
        LEFT JOIN prenotazioni p ON p.corsa_id = c.id
        LEFT JOIN utente cl ON cl.id = p.cliente_id
        LEFT JOIN veicolo v ON v.id = c.veicolo_id
        LEFT JOIN utente a ON a.id = v.driver_id
        WHERE c.stato = 'in_corso'
      `),
      // ===================== Autisti live =====================
      pool.query(`
        SELECT u.id,
               u.nome,
               ST_Y(v.origine::geometry) AS lat,
               ST_X(v.origine::geometry) AS lng,
               CASE WHEN dv.start <= NOW() AND dv.fine >= NOW() THEN true ELSE false END AS disponibile
        FROM utente u
        LEFT JOIN veicolo v ON v.driver_id = u.id
        LEFT JOIN disponibilita_veicolo dv ON dv.veicolo_id = v.id
        WHERE LOWER(TRIM(u.tipo)) = 'autista'
      `)
    ]);

    // ===================== Calcoli KPI =====================
    const data = mainRes.rows[0];
    const corseTotali = Number(data.corse_totali);
    const autistiTotali = Number(data.autisti);
    const prezzo_medio_corsa = corseTotali > 0 ? parseFloat((Number(data.fatturato)/corseTotali).toFixed(2)) : 0;
    const guadagno_medio_autista = autistiTotali > 0 ? parseFloat((Number(data.guadagno)/autistiTotali).toFixed(2)) : 0;

    // ===================== JSON response =====================
    res.json({
      clienti: Number(data.clienti),
      autisti: Number(data.autisti),
      veicoli: Number(data.veicoli),
      veicoli_disponibili: Number(data.veicoli_disponibili),
      corse_totali: corseTotali,
      corse_oggi: Number(data.corse_oggi),
      fatturato: Number(data.fatturato),
      guadagno: Number(data.guadagno),
      prezzo_medio_corsa,
      guadagno_medio_autista,
      crescita: crescitaRes.rows.map(r => ({ giorno: r.giorno, ricavi: Number(r.ricavi) })),
      top_autisti: topAutistiRes.rows.map(a => ({
        nome: a.nome,
        corse: Number(a.corse),
        guadagno: Number(a.guadagno)
      })),
      corse: corseLiveRes.rows.map(r => ({
        id: r.id,
        cliente: r.cliente,
        autista: r.autista,
        prezzo: Number(r.prezzo),
        stato: r.stato,
        lat: Number(r.lat) || 0,
        lng: Number(r.lng) || 0
      })),
      autisti_live: autistiLiveRes.rows.map(r => ({
        id: r.id,
        nome: r.nome,
        lat: Number(r.lat) || 0,
        lng: Number(r.lng) || 0,
        disponibile: r.disponibile
      }))
    });

  } catch (err) {
    console.error("Errore nella route /admin/dashboard:", err);
    res.status(500).json({
      error: 'Errore dashboard',
      details: err.message
    });
  }
});

export default router;