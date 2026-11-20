import express from "express";
import { performance } from "node:perf_hooks";
// Importazione standard: se nel file di servizio usi 'export async function cercaSlotUltra'
import { cercaSlotUltra } from "../services/search/search.service.js";
import { catalogoBookingEnabled } from "../services/search/search-catalogo-territoriale.service.js";

import { coordinatePolo, suggerimentiPoli } from "../services/search/search-poli-pubblici.service.js";

import { coordinatePolo, suggerimentiPoli } from "../services/search/search-poli-pubblici.service.js";

const router = express.Router();

async function richiestaGooglePlaces(path, fieldMask, body) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("Google Places non configurato");
  const risposta = await fetch(`https://places.googleapis.com/v1/${path}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
      ...(body && { "Content-Type": "application/json" })
    },
    ...(body && { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(6000)
  });
  if (!risposta.ok) {
    const errore = new Error(`Google Places HTTP ${risposta.status}`);
    errore.http = risposta.status;
    throw errore;
  }
  return risposta.json();
}

router.get("/suggerimenti", async (req, res) => {
  const testo = typeof req.query.testo === "string" ? req.query.testo.trim() : "";
  if (testo.length < 2 || testo.length > 180) {
    return res.status(400).json({ error: "Inserisci un nome o un indirizzo valido." });
  }
  const poli = await suggerimentiPoli(testo).catch(errore => {
    console.warn("[SEARCH] Catalogo luoghi non disponibile:", errore.code ?? errore.name);
    return [];
  });
  try {
    const { suggestions = [] } = await richiestaGooglePlaces(
      "places:autocomplete",
      "suggestions.placePrediction.placeId,suggestions.placePrediction.text",
      { input: testo, languageCode: "it", regionCode: "it",
        locationBias: { circle: { center: { latitude: 40.35, longitude: 18.17 }, radius: 50000 } } }
    );
    const luoghi = suggestions.flatMap(({ placePrediction }) => {
      const place_id = placePrediction?.placeId;
      const description = placePrediction?.text?.text;
      return place_id && description ? [{ place_id, description }] : [];
    });
    return res.set("Cache-Control", "no-store").json([...poli, ...luoghi]);
  } catch (errore) {
    console.warn("[SEARCH] Suggerimenti Google non disponibili:", errore.http ?? errore.name);
    if (poli.length) return res.set("Cache-Control", "no-store").json(poli);
    return res.status(502).json({ error: "Suggerimenti non disponibili. Riprova." });
  }
});

router.get("/luoghi/:placeId", async (req, res) => {
  const { placeId } = req.params;
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(placeId)) {
    return res.status(400).json({ error: "Località non valida." });
  }
  if (placeId.startsWith("turentu_")) {
    try {
      const coordinate = await coordinatePolo(placeId);
      if (!coordinate) return res.status(404).json({ error: "Località non più disponibile." });
      return res.set("Cache-Control", "no-store").json(coordinate);
    } catch (errore) {
      console.warn("[SEARCH] Dettagli del polo non disponibili:", errore.code ?? errore.name);
      return res.status(502).json({ error: "Impossibile aprire la località. Riprova." });
    }
  }
  try {
    const { location } = await richiestaGooglePlaces(`places/${encodeURIComponent(placeId)}`, "location");
    const lat = location?.latitude;
    const lng = location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
        (lat === 0 && lng === 0)) {
      return res.status(404).json({ error: "Coordinate non trovate. Scegli un altro suggerimento." });
    }
    return res.set("Cache-Control", "no-store").json({ lat, lng });
  } catch (errore) {
    if (errore.http === 404) return res.status(404).json({ error: "Località non più disponibile." });
    console.warn("[SEARCH] Dettagli Google non disponibili:", errore.http ?? errore.name);
    return res.status(502).json({ error: "Impossibile aprire la località. Riprova." });
  }
});

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

    const inizio = performance.now();
    const risultati = await cercaSlotUltra(form, {
      collaudoCatalogoTerritoriale: process.env.POPBUS_CATALOGO_TERRITORIALE_COLLAUDO === '1',
      prenotazioneCatalogo: catalogoBookingEnabled() && form.catalogo_fermate === true
    });
    console.log(`⏱️ Performance Timer: cercaSlotUltra: ${(performance.now() - inizio).toFixed(1)} ms`);

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
        origine_fermata_id: r.origine_fermata_id ?? null,
        destinazione_fermata_id: r.destinazione_fermata_id ?? null,
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
    // Le coppie di fermate sono trasmesse nei risultati POPBUS, non come
    // ulteriori corse. Il backend booking deve comunque riquotare ogni scelta.
    const risultatiPubblici = (risultati || []).map(item => {
      const fermate = item.fermate_pixel_popbus;
      const raccolta = item.raccolta_popbus;
      if (!fermate?.salita?.provvisoria && !fermate?.discesa?.provvisoria && !raccolta?.provvisoria) return item;
      const pubblica = fermata => {
        if (!fermata?.provvisoria) return fermata;
        const { lat, lon, ...riferimento } = fermata;
        return riferimento;
      };
      return {
        ...item,
        ...(raccolta?.provvisoria && { raccolta_popbus: pubblica(raccolta) }),
        ...(fermate && { fermate_pixel_popbus: {
          salita: pubblica(fermate.salita), discesa: pubblica(fermate.discesa)
        } })
      };
    });
    return res.json(risultatiPubblici);

  } catch (err) {
    console.error("❌ CRITICAL SEARCH ERROR:", err);
    return res.status(500).json({
      error: "Errore durante la ricerca",
      details: err.message
    });
  }
});

export default router;