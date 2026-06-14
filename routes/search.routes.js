import express from "express";
// Importazione standard: se nel file di servizio usi 'export async function cercaSlotUltra'
import { cercaSlotUltra } from "../services/search/search.service.js";

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
      console.warn("❌ REQUEST REJECTED: Missing fields");
      return res.status(400).json({ error: "Dati geografici o posizioni mancanti" });
    }

    // 2. ESECUZIONE
    // Verifichiamo che la funzione sia caricata correttamente
    if (typeof cercaSlotUltra !== 'function') {
      throw new Error("Il servizio di ricerca 'cercaSlotUltra' non è stato importato correttamente.");
    }

    console.time("⏱️ Performance Timer: cercaSlotUltra");
    const risultati = await cercaSlotUltra(form);
    console.timeEnd("⏱️ Performance Timer: cercaSlotUltra");

    console.log(`🔍 Search elaborata. Risultati trovati: ${risultati?.length || 0}`);

    // 3. DEBUG LOGGING
    if (risultati?.length > 0) {
      console.log(`📡 [DEBUG API] Inviando ${risultati.length} elementi.`);
    } else {
      console.log("📡 [DEBUG API] Nessun risultato trovato.");
    }

    // 4. INVIO RISPOSTA
    return res.json(risultati || []);

  } catch (err) {
    console.error("❌ CRITICAL SEARCH ERROR:", err);
    return res.status(500).json({
      error: "Errore durante la ricerca",
      details: err.message
    });
  }
});

export default router;