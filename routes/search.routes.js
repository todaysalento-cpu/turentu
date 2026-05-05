import express from "express";
const router = express.Router();

router.post("/", async (req, res) => {
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

    // =========================
    // 🔒 VALIDAZIONE INPUT (NO FALLBACK FALSI)
    // =========================
    if (!form.coord || !form.coordDest) {
      console.log("❌ REQUEST INVALID: missing coordinates");

      return res.status(400).json({
        error: "coord e coordDest sono obbligatorie",
      });
    }

    if (!form.localitaOrigine || !form.localitaDestinazione) {
      console.log("❌ REQUEST INVALID: missing locations");

      return res.status(400).json({
        error: "localitaOrigine e localitaDestinazione sono obbligatorie",
      });
    }

    if (!form.start_datetime) {
      return res.status(400).json({
        error: "start_datetime mancante",
      });
    }

    if (!form.posti_richiesti) {
      return res.status(400).json({
        error: "posti_richiesti mancante",
      });
    }

    // =========================
    // 🚀 BUSINESS LOGIC
    // =========================
    const { cercaSlotUltra } = await import(
      "../services/search/search.service.js"
    );

    const risultati = await cercaSlotUltra(form);

    console.log("🔍 Search risultati:", risultati.length);

    return res.json(risultati);
  } catch (err) {
    console.error("❌ Search error:", err);

    return res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
});

export default router;