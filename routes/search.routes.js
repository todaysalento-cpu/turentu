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

    // Diagnostica PIXEL: sola lettura, non modifica i risultati della ricerca.
    const risultatiPopbus = Array.isArray(risultati)
      ? risultati.filter((r) =>
          r && (
            r.tipo === "pop-bus" ||
            String(r.id ?? "").includes("virtual_pop") ||
            r.origine_nodo_territoriale_id !== undefined ||
            r.destinazione_nodo_territoriale_id !== undefined
          )
        )
      : [];

    console.log("📍 [PIXEL TEST] Risultati POPBUS:", risultatiPopbus.length);
    console.log("📍 [PIXEL TEST RISULTATI]", JSON.stringify(
      risultatiPopbus.map((r) => ({
        id: r.id,
        tipo: r.tipo,
        classe: r.classe,
        origine_nodo_territoriale_id: r.origine_nodo_territoriale_id ?? null,
        destinazione_nodo_territoriale_id: r.destinazione_nodo_territoriale_id ?? null,
        pixel_fermate_disponibili: r.pixel_fermate_disponibili ?? null,
        pixel_stato: r.pixel_stato ?? null
      })),
      null,
      2
    ));

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