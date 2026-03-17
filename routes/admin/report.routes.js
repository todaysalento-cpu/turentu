// routes/admin/report.routes.js
import express from 'express';
const router = express.Router();

// GET /admin/report
router.get('/', async (req, res) => {
  try {
    const report = {
      totaleCorse: 120,
      ricaviTotali: 4500,
      topAutisti: [
        { nome: 'Luigi', corse: 15, guadagno: 500 },
        { nome: 'Maria', corse: 12, guadagno: 420 },
      ],
    };

    res.json({ message: 'Report e statistiche', report });
  } catch (err) {
    console.error('❌ Report admin error:', err.message);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

export default router;