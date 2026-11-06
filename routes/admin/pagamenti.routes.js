import express from 'express';
import { pool } from '../../db/db.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';
import Stripe from 'stripe';
import { reconcileAdminPayment } from '../../services/payments/admin-reconciliation.service.js';

const router = express.Router();

// GET /admin/pagamenti
router.get('/', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  try {
    // Utilizziamo la relazione corretta: p -> pr -> c
    const { rows: pagamenti } = await pool.query(`
      SELECT 
        pr.corsa_id AS id,
        p.id AS pagamento_id,
        c.created_at,
        COALESCE(u_cliente.nome, 'Cliente Ignoto') AS cliente,
        COALESCE(u_autista.nome, 'Autista Ignoto') AS autista,
        p.importo AS prezzo_totale,
        p.commissione,
        p.guadagno_autista,
        CASE
          WHEN p.stato = 'pagato' THEN 'rilasciato'
          WHEN p.stato = 'rimborsato' THEN 'rimborsato'
          ELSE 'bloccato'
        END AS stato_pagamento
      FROM pagamenti p
      JOIN prenotazioni pr ON p.prenotazione_id = pr.id
      JOIN corse c ON pr.corsa_id = c.id
      LEFT JOIN utente u_cliente ON pr.cliente_id = u_cliente.id
      LEFT JOIN veicolo v ON c.veicolo_id = v.id
      LEFT JOIN utente u_autista ON v.driver_id = u_autista.id
      ORDER BY p.id DESC
      LIMIT 50
    `);

    const totale = pagamenti.reduce((sum, p) => sum + Number(p.prezzo_totale || 0), 0);
    const commissioni = pagamenti.reduce((sum, p) => sum + Number(p.commissione || 0), 0);
    const bloccati = pagamenti
      .filter(p => p.stato_pagamento === 'bloccato')
      .reduce((sum, p) => sum + Number(p.prezzo_totale || 0), 0);

    res.json({ totale, commissioni, bloccati, pagamenti });
  } catch (err) {
    console.error('❌ Pagamenti admin error:', err.message);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

// POST /admin/pagamenti/:id/:action
router.post('/:id/:action', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  const { id, action } = req.params;
  
  try {
    const stripe = process.env.STRIPE_SECRET_KEY
      ? new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 10000, maxNetworkRetries: 1 })
      : null;
    const result = await reconcileAdminPayment({
      pool, stripe, corsaId: id, paymentId: req.body?.pagamento_id, action,
    });
    res.json({ success: true, message: 'Esito Stripe verificato e riconciliato', ...result });
  } catch (err) {
    console.error('❌ Errore SQL dettagliato:', err.message);
    const status = [400, 404, 409, 503].includes(err.status) ? err.status : 502;
    res.status(status).json({ error: status === 502 ? 'Verifica pagamento non riuscita' : err.message });
  }
});

export default router;
