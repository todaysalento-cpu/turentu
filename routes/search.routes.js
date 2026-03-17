import express from 'express';
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const form = req.body;
    if (!form.coordDest) form.coordDest = { lat: 0, lon: 0 };

    const { cercaSlotUltra } = await import('../services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);

    console.log('🔍 Search risultati:', risultati.length);
    res.json(risultati);
  } catch (err) {
    console.error('❌ Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;