import express from 'express';
import { pool } from '../../db/db.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// GET /admin/pagamenti
router.get('/', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  try {
    // Utilizziamo la relazione corretta: p -> pr -> c
    const { rows: pagamenti } = await pool.query(`
      SELECT 
        pr.corsa_id AS id,
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
    const nuovoStato = action === 'rilascia' ? 'pagato' : 'rimborsato';
    
    // Per l'aggiornamento, siccome visualizziamo l'ID come corsa_id, 
    // cerchiamo il pagamento associato a quella corsa tramite la tabella prenotazioni
    const result = await pool.query(`
      UPDATE pagamenti 
      SET stato = $1, updated_at = NOW() 
      WHERE prenotazione_id IN (SELECT id FROM prenotazioni WHERE corsa_id = $2)
    `, [nuovoStato, id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pagamento non trovato per questa corsa' });
    }
    
    res.json({ success: true, message: `Azione ${action} eseguita correttamente` });
  } catch (err) {
    console.error('❌ Errore SQL dettagliato:', err.message);
    res.status(500).json({ error: 'Errore durante l\'aggiornamento' });
  }
});

export default router;