import express from "express";
import { pool } from "../db/db.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/pagamenti/autista
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

        v.id AS veicolo_id,
        v.driver_id

      FROM pagamenti p
      INNER JOIN corse c ON c.id = p.corsa_id
      INNER JOIN veicolo v ON v.id = c.veicolo_id
      WHERE v.driver_id = $1
    `;

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