import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { createCorsaFromDirettrice } from '../services/corsa/corsa.service.js';
import { notifyUser } from '../services/notifications/notification.service.js';

const router = express.Router();
router.use(authMiddleware);

// ==========================================
// ROTTA: GET Offerte PopBus attive per l'autista loggato
// ==========================================
router.get('/offerte/veicolo/:veicolo_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { veicolo_id } = req.params;
    const autistaId = req.user.id;

    console.log(`🔎 [GET OFFERTE] Recupero offerte PopBus attive per autista ID: ${autistaId} (Veicolo richiesto:${veicolo_id})`);

    const result = await client.query(`
      SELECT 
        o.id, 
        o.direttrice_id, 
        o.autista_id,
        o.stato, 
        o.expires_at,
        d.tipo_servizio as classe, 
        -- Orario calcolato dal segmento o fallback sulla partenza prevista della direttrice
        COALESCE(s.start_datetime, d.partenza_prevista) as orario,
        d.distanza_totale_km,
        s.posti_occupati as posti_richiesti,
        -- Prezzo reale proveniente dal ricavo stimato del segmento
        COALESCE(s.ricavo_stimato, 0) as prezzo,
        -- Nomi dei nodi di origine e destinazione dalla tabella 'nodi_direttrice' (colonna 'nome_nodo')
        n_start.nome_nodo AS origine_address,
        n_end.nome_nodo AS destinazione_address,
        COALESCE(s.start_node_id, d.start_node_id) as start_node_id,
        COALESCE(s.end_node_id, d.end_node_id) as end_node_id
      FROM offerte_autisti o
      JOIN direttrici_virtuali d ON o.direttrice_id = d.id
      LEFT JOIN segmenti s ON s.direttrice_id = d.id AND s.stato = 'attivo'
      LEFT JOIN nodi_direttrice n_start ON COALESCE(s.start_node_id, d.start_node_id) = n_start.id
      LEFT JOIN nodi_direttrice n_end ON COALESCE(s.end_node_id, d.end_node_id) = n_end.id
      WHERE o.autista_id = $1 
        AND o.stato = 'inviata' 
        AND o.expires_at > NOW()
    `, [autistaId]);

    console.log(`🔎 [GET OFFERTE] Trovate ${result.rows.length} offerte attive con dettagli completi.`);
    res.json({ offerte: result.rows });
  } catch (err) {
    console.error("❌ [GET OFFERTE] Errore nel recupero offerte PopBus:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// POST: Accetta offerta PopBus
// ==========================================
router.post('/:offerta_id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const offertaId = Number(req.params.offerta_id);
    const autistaId = req.user.id;

    console.log(`🟢 [ACCETTA] Avvio processo accett