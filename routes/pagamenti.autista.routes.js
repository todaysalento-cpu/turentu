import express from "express";
import pool from "../db/db.js"; // ✔ FIX IMPORT (db/db.js)
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/pagamenti/autista
 * Query params:
 * - status: tutti | pagato | pendente | rimborsato | autorizzazione
 */
router.get("/autista", authMiddleware, async (req, res) => {
  try {
    const autistaId = req.user.id;
    const { status } = req.query;

    const values = [autistaId];
    let idx = 2;

    let query = `
      SELECT 
        p.id,
        p.importo,
        p.stato,
        p.currency,
        p.commissione,
        p.guadagno_autista,
        p.updated_at,
        p.tipo_corsa,
        p.corsa_id,

        c.start_datetime,
        c.origine_address,
        c.destinazione_address,

        pr.id AS prenotazione_id
      FROM pagamenti p
      INNER JOIN corse c ON c.id = p.corsa_id
      LEFT JOIN prenotazioni pr ON pr.id = p.prenotazione_id
      WHERE c.autista_id = $1
    `;

    // filtro stato pagamento
    if (status && status !== "tutti") {
      query += ` AND p.stato = $${idx}`;
      values.push(status);
      idx++;
    }

    query += ` ORDER BY p.updated_at DESC`;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error("❌ Errore pagamenti autista:", err);

    res.status(500).json({
      success: false,
      error: "Errore server pagamenti",
    });
  }
});

export default router;