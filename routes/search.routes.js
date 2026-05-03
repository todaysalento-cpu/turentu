import express from 'express';
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const form = req.body;

    // =========================
    // 🔥 LOG REQUEST COMPLETA
    // =========================
    console.log("==================================");
    console.log("📩 /api/search REQUEST");
    console.log("BODY:", JSON.stringify(form, null, 2));
    console.log("HEADERS:", req.headers);
    console.log("==================================");

    // FIX DEFENSIVO
    if (!form.coordDest) {
      console.log("⚠️ coordDest mancante → fallback 0,0");
      form.coordDest = { lat: 0, lon: 0 };
    }

    if (!form.coord) {
      console.log("⚠️ coord origine mancante → fallback 0,0");
      form.coord = { lat: 0, lon: 0 };
    }

    const { cercaSlotUltra } = await import('../services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);

    console.log('🔍 Search risultati:', risultati.length);

    res.json(risultati);

  } catch (err) {
    console.error('❌ Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;