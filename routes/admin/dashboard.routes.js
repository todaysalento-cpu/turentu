import express from 'express';
import { pool } from '../../db/db.js';
import { vehicleCoordinates } from './vehicle-overview.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // ===================== KPI principali =====================
    const query = `
      WITH
      inizio_oggi AS (
        SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome' AS inizio
      ),
      contatori_utenti AS (
        SELECT
          count(*) FILTER (WHERE lower(btrim(tipo)) = 'cliente') AS clienti,
          count(*) FILTER (WHERE lower(btrim(tipo)) = 'autista') AS autisti,
          count(*) FILTER (WHERE lower(btrim(tipo)) = 'cliente'
            AND created_at BETWEEN inizio AND now()) AS nuovi_clienti_oggi,
          count(*) FILTER (WHERE lower(btrim(tipo)) = 'autista'
            AND created_at BETWEEN inizio AND now()) AS nuovi_autisti_oggi,
          count(*) FILTER (WHERE lower(btrim(tipo)) = 'autista' AND modalita_operativa = 'flotta') AS flotte_ncc,
          count(*) FILTER (WHERE lower(btrim(tipo)) = 'autista' AND modalita_operativa = 'singolo') AS operatori_singoli
        FROM utente CROSS JOIN inizio_oggi WHERE eliminato_il IS NULL
      ),
      veicoli AS (
        SELECT count(*) AS totale,
          count(*) FILTER (WHERE v.created_at BETWEEN inizio AND now()) AS nuovi_oggi
        FROM veicolo v
        LEFT JOIN utente u ON v.driver_id = u.id
        CROSS JOIN inizio_oggi
        WHERE u.eliminato_il IS NULL
      ),
      veicoli_disponibili AS (
        SELECT COUNT(*) AS totale
        FROM veicolo v
        JOIN disponibilita_veicolo dv ON dv.veicolo_id = v.id
        WHERE dv.start <= NOW() AND dv.fine >= NOW()
      ),
      corse_totali AS (SELECT COUNT(*) AS totale FROM corse),
      corse_oggi AS (SELECT COUNT(*) AS totale FROM corse WHERE DATE(created_at) = CURRENT_DATE),
      fatturato AS (SELECT COALESCE(SUM(importo),0)::numeric(20,2) AS totale FROM pagamenti WHERE stato = 'pagato'),
      guadagno AS (SELECT COALESCE(SUM(guadagno_autista),0)::numeric(20,2) AS totale FROM pagamenti WHERE stato = 'pagato'),
      commissioni AS (SELECT COALESCE(SUM(commissione),0)::numeric(20,2) AS totale FROM pagamenti WHERE stato = 'pagato'),
      pagamenti_non_contabilizzati AS (
        SELECT COUNT(*) AS totale FROM pagamenti
        WHERE stato = 'pagato' AND (
          commissione IS NULL OR guadagno_autista IS NULL
          OR (COALESCE(commissione,0) = 0 AND COALESCE(guadagno_autista,0) = 0 AND importo > 0)
          OR ABS(importo - COALESCE(commissione,0) - COALESCE(guadagno_autista,0)) > 0.009
        )
      )
      SELECT contatori_utenti.*, (SELECT totale FROM veicoli) AS veicoli,
             (SELECT nuovi_oggi FROM veicoli) AS nuovi_veicoli_oggi,
             (SELECT totale FROM veicoli_disponibili) AS veicoli_disponibili, (SELECT totale FROM corse_totali) AS corse_totali, 
             (SELECT totale FROM corse_oggi) AS corse_oggi, (SELECT totale FROM fatturato) AS fatturato, (SELECT totale FROM guadagno) AS guadagno,
             (SELECT totale FROM commissioni) AS commissioni_turentu,
             (SELECT totale FROM pagamenti_non_contabilizzati) AS pagamenti_non_contabilizzati
      FROM contatori_utenti
    `;

    // ===================== Parallel fetch =====================
    const [
      mainRes,
      crescitaRes,
      topAutistiRes,
      corseLiveRes,
      autistiLiveRes,
      partenzeRes
    ] = await Promise.all([
      pool.query(query),
      pool.query(`
        SELECT DATE(updated_at) AS giorno, COALESCE(SUM(importo)::numeric(20,2),0) AS ricavi
        FROM pagamenti
        WHERE stato='pagato' AND updated_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY giorno ORDER BY giorno
      `),
      pool.query(`
        SELECT u.id AS operatore_id, u.nome, COUNT(DISTINCT c.id) AS corse, COALESCE(SUM(p.guadagno_autista),0)::numeric(20,2) AS guadagno
        FROM pagamenti p
        LEFT JOIN corse c ON c.id = p.corsa_id
        LEFT JOIN veicolo v ON v.id = c.veicolo_id
        LEFT JOIN utente u ON u.id = v.driver_id
        WHERE p.stato='pagato'
        GROUP BY u.id, u.nome ORDER BY guadagno DESC LIMIT 5
      `),
      // ===================== Query corretta con DISTINCT ON =====================
      pool.query(`
        SELECT DISTINCT ON (c.id)
               c.id,
               COALESCE(cl.nome, 'Sconosciuto') AS cliente,
               COALESCE(a.nome, 'Non assegnato') AS autista,
               c.prezzo_fisso AS prezzo,
               c.stato,
               c.origine_address,
               c.destinazione_address,
               c.created_at,
               c.posti_totali,
               c.posti_prenotati,
               c.tipo_corsa,
               ST_Y(c.origine::geometry) AS lat,
               ST_X(c.origine::geometry) AS lng
        FROM corse c
        LEFT JOIN prenotazioni p ON p.corsa_id = c.id
        LEFT JOIN utente cl ON cl.id = p.cliente_id
        LEFT JOIN veicolo v ON v.id = c.veicolo_id
        LEFT JOIN utente a ON a.id = v.driver_id
        ORDER BY c.id, c.created_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT u.id, u.nome, ST_Y(pv.coord::geometry) AS lat, ST_X(pv.coord::geometry) AS lng,
               CASE WHEN dv.start <= NOW() AND dv.fine >= NOW() THEN true ELSE false END AS disponibile
        FROM utente u
        LEFT JOIN veicolo v ON v.driver_id = u.id
        LEFT JOIN disponibilita_veicolo dv ON dv.veicolo_id = v.id
        LEFT JOIN posizione_veicolo pv ON pv.veicolo_id = v.id AND pv.tipo = 'CORRENTE'
        WHERE u.eliminato_il IS NULL AND LOWER(TRIM(u.tipo)) = 'autista'
      `),
      pool.query(`
        SELECT v.id, v.marca, v.modello, v.targa, v.localita, u.nome AS nome_autista,
          ${vehicleCoordinates}
        FROM veicolo v JOIN utente u ON u.id = v.driver_id
        WHERE v.coord IS NOT NULL AND u.eliminato_il IS NULL AND lower(btrim(u.tipo)) = 'autista'
        ORDER BY v.id
      `)
    ]);

    const data = mainRes.rows[0];
    const corseTotali = Number(data.corse_totali);
    const autistiTotali = Number(data.autisti);

    res.json({
      clienti: Number(data.clienti),
      autisti: Number(data.autisti),
      nuovi_clienti_oggi: Number(data.nuovi_clienti_oggi),
      nuovi_autisti_oggi: Number(data.nuovi_autisti_oggi),
      flotte_ncc: Number(data.flotte_ncc),
      operatori_singoli: Number(data.operatori_singoli),
      veicoli: Number(data.veicoli),
      nuovi_veicoli_oggi: Number(data.nuovi_veicoli_oggi),
      veicoli_disponibili: Number(data.veicoli_disponibili),
      corse_totali: corseTotali,
      corse_oggi: Number(data.corse_oggi),
      fatturato: Number(data.fatturato),
      guadagno: Number(data.guadagno),
      incassi_clienti: Number(data.fatturato),
      commissioni_turentu: Number(data.commissioni_turentu),
      competenze_operatori: Number(data.guadagno),
      pagamenti_non_contabilizzati: Number(data.pagamenti_non_contabilizzati),
      prezzo_medio_corsa: corseTotali > 0 ? parseFloat((Number(data.fatturato)/corseTotali).toFixed(2)) : 0,
      guadagno_medio_autista: autistiTotali > 0 ? parseFloat((Number(data.guadagno)/autistiTotali).toFixed(2)) : 0,
      crescita: crescitaRes.rows.map(r => ({ giorno: r.giorno, ricavi: Number(r.ricavi) })),
      top_autisti: topAutistiRes.rows.map(a => ({ operatore_id: a.operatore_id, nome: a.nome, corse: Number(a.corse), guadagno: Number(a.guadagno) })),
      veicoli_partenza: partenzeRes.rows,
      corse: corseLiveRes.rows.map(r => ({
        id: r.id,
        cliente: r.cliente,
        autista: r.autista,
        prezzo: Number(r.prezzo),
        stato: r.stato,
        origine: r.origine_address,
        destinazione: r.destinazione_address,
        data: r.created_at,
        posti: `${r.posti_prenotati}/${r.posti_totali}`,
        tipo: r.tipo_corsa,
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
    res.status(500).json({ error: 'Errore dashboard', details: err.message });
  }
});

export default router;
