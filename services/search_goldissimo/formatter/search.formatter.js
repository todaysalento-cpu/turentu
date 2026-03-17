import { v4 as uuidv4 } from 'uuid';
import { haversineDistance } from '../../../utils/geo.util.js';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza } from '../../../utils/maps.util.js';
import { TOP_RESULTS } from '../search.cache.js';

export async function formatResults(richiesta, slotsFiltrati, corseFiltrate, veicoliCache) {
  // Stima distanza/durata tra origine e destinazione richiesta
  const { durataMs: durataRichiesta = 0, distanzaKm: distanzaRichiesta = 0 } = richiesta.coordDest
    ? await getDurataDistanza(richiesta.coord, richiesta.coordDest)
    : { durataMs: 0, distanzaKm: 0 };

  // --- SLOT LIBERI ---
  const slotResults = await Promise.all(
    slotsFiltrati.slice(0, TOP_RESULTS).map(async (slot) => {
      const v = veicoliCache[slot.veicolo_id];

      // Ora usiamo start_datetime della richiesta
      const oraPartenza = new Date(richiesta.start_datetime); // ← cambio
      const oraArrivo = new Date(oraPartenza.getTime() + Number(durataRichiesta || 0));


      const prezzo = await calcolaPrezzo(
        { km: Number(distanzaRichiesta), tipo_corsa: 'libero', posti_prenotati: 0, primo_posto: 0 },
        Number(v.euro_km ?? 1),
        1,
        richiesta.posti_richiesti,
        'libero'
      );

      return {
        tipo: 'slot',
        id: uuidv4(),
        veicolo_id: v.id,
        modello: v.modello,
        servizi: Array.isArray(v.servizi) ? v.servizi : JSON.parse(v?.servizi ?? '[]'),
        coordOrigine: richiesta.coord,
        coordDestinazione: richiesta.coordDest,
        oraPartenza,
        oraArrivo,
        durataMs: Number(durataRichiesta),
        distanzaKm: Number(distanzaRichiesta),
        postiTotali: v.posti_totali,
        postiRichiesti: richiesta.posti_richiesti,
        prezzo,
        euro_km: Number(v.euro_km ?? 1),
        stato: 'libero',
        corseCompatibili: []
      };
    })
  );

  // --- CORSE COMPATIBILI ---
  const corsaResults = await Promise.all(
    corseFiltrate.slice(0, TOP_RESULTS).map(async (corsa) => {
      const v = veicoliCache[corsa.veicolo_id];
      const oraPartenza = new Date(corsa.start_datetime);
         const durataMsCorsa = Number(corsa.durata ?? 0) * 1000;
    const oraArrivo = new Date(oraPartenza.getTime() + durataMsCorsa);

    // Prezzo passeggero preso dal veicolo, fallback a 1
    const prezzoPasseggero = Number(v?.prezzo_passeggero ?? 1);

    const prezzo = await calcolaPrezzo(
      {
        km: Number(corsa.distanza ?? 0),
        tipo_corsa: corsa.tipo_corsa ?? 'condiviso',
        posti_prenotati: corsa.posti_prenotati ?? 0,
        primo_posto: corsa.primo_posto ?? 0
      },
      Number(corsa.euro_km ?? v?.euro_km ?? 1),
      prezzoPasseggero,                // <-- qui il prezzo passeggero dal veicolo
      richiesta.posti_richiesti,
      corsa.stato === 'libero' ? 'libero' : 'condiviso'
    );

    return {
      tipo: 'corsa',
      id: uuidv4(),
      veicolo_id: corsa.veicolo_id,
      modello: v?.modello ?? 'N/D',
      servizi: Array.isArray(v?.servizi) ? v.servizi : JSON.parse(v?.servizi ?? '[]'),
      coordOrigine: { lat: corsa.origine_lat, lon: corsa.origine_lon },
      coordDestinazione: { lat: corsa.dest_lat, lon: corsa.dest_lon },
      oraPartenza,
      oraArrivo,
      durataMs: Number(corsa.durata ?? 0) * 1000,        // durata in ms
      distanzaKm: Number(corsa.distanza ?? 0),
      euro_km: Number(v?.euro_km ?? 1),
      prezzo,
      stato: corsa.stato ?? 'prenotabile',
      postiPrenotati: Number(corsa.posti_prenotati ?? 0), // aggiunto
      primoPosto: Number(corsa.primo_posto ?? 0),         // aggiunto
      corseCompatibili: [corsa]
   };

    })
  );

  return [...slotResults, ...corsaResults];
}
