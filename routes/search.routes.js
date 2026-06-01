import express from "express";
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const form = req.body;

    console.log("==================================");
    console.log("📩 /api/search REQUEST RECEIVED");
    console.log(`Da: ${form.localitaOrigine} | Per: ${form.localitaDestinazione}`);
    console.log(`Data: ${form.start_datetime} | Posti: ${form.posti_richiesti}`);
    console.log("==================================");

    // 1. VALIDAZIONE
    if (!form.coord || !form.coordDest || !form.localitaOrigine || !form.localitaDestinazione) {
      console.log("❌ REQUEST REJECTED: Missing fields");
      return res.status(400).json({ error: "Dati geografici o posizioni mancanti" });
    }

    // 2. ESECUZIONE (Import dinamico per evitare cicli)
    const { cercaSlotUltra } = await import("../services/search/search.service.js");

    console.time("⏱️ Performance Timer: cercaSlotUltra");
    const risultati = await cercaSlotUltra(form);
    console.timeEnd("⏱️ Performance Timer: cercaSlotUltra");

    console.log(`🔍 Search elaborata. Risultati trovati: ${risultati ? risultati.length : 0}`);

    // 3. DEBUG TRACCIAMENTO USCITA
    if (risultati && risultati.length > 0) {
      console.log(`📡 [DEBUG API] Inviando ${risultati.length} elementi.`);
      console.log(`📡 [DEBUG API] ID elementi inviati: ${risultati.map(r => r.id).join(', ')}`);
    } else {
      console.log("📡 [DEBUG API] Payload inviato: [] (Array vuoto)");
    }

    // 4. INVIO RISPOSTA
    return res.json(risultati || []);

  } catch (err) {
    console.error("❌ CRITICAL SEARCH ERROR:");
    console.error(err);
    return res.status(500).json({
      error: "Errore durante la ricerca",
      details: err.message
    });
  }
});

export default router;