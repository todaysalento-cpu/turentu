import express from 'express';
import { pool } from '../../db/db.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// GET /admin/pagamenti
router.get('/', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  try {
    const { rows: pagamenti } = await pool.query(`
      SELECT DISTINCT ON (c.id)
        c.id AS id,
        c.id AS corsa_id,
        c.created_at,
        u_cliente.nome AS cliente,
        u_autista.nome AS autista,
        c.prezzo_fisso AS prezzo_totale,
        (c.prezzo_fisso * 0.1)::numeric(10,2) AS commissione,
        (c.prezzo_fisso * 0.9)::numeric(10,2) AS guadagno_autista,
        CASE
          WHEN c.stato = 'completata' THEN 'rilasciato'
          ELSE 'bloccato'
        END AS stato_pagamento
      FROM corse c
      JOIN prenotazioni p ON p.corsa_id = c.id
      JOIN utente u_cliente ON p.cliente_id = u_cliente.id
      JOIN veicolo v ON c.veicolo_id = v.id
      JOIN utente u_autista ON v.driver_id = u_autista.id
      ORDER BY c.id, c.created_at DESC
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

// NUOVA ROTTA POST per gestire azioni (rilascia/rimborso)
router.post('/:id/:action', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  const { id, action } = req.params;
  
  try {
    // Logica di aggiornamento (es. cambiare stato della corsa in base all'azione)
    // Se 'rilascia', potresti voler impostare lo stato della corsa a 'pagato'
    // Se 'rimborso', potresti voler impostare a 'rimborsato'
    const nuovoStato = action === 'rilascia' ? 'pagato' : 'rimborsato';
    
    await pool.query('UPDATE corse SET stato = $1 WHERE id = $2', [nuovoStato, id]);
    
    res.json({ success: true, message: `Azione ${action} eseguita con successo` });
  } catch (err) {
    console.error('❌ Errore aggiornamento stato pagamento:', err);
    res.status(500).json({ error: 'Errore aggiornamento database' });
  }
});

export default router;