// routes/admin/impostazioni.routes.js
import express from 'express';
const router = express.Router();

// GET /admin/impostazioni
router.get('/', async (req, res) => {
  try {
    const settings = {
      commissioneDefault: 10,
      valuta: 'EUR',
    };
    res.json({ message: 'Impostazioni admin', settings });
  } catch (err) {
    console.error('❌ Impostazioni admin error:', err.message);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

export default router;