import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilita } from './disponibilita/disponibilita.service.js';
import { redisClient } from '../../redis.js';
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const targetDate = new Date(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. Recupero candidati da Redis
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  // 2. Recupero prenotazioni batch
  let prenotazioniBatch = [];
  if (corseCandidate.length > 0) {
    const pipeline = redisClient.multi();
    corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
    prenotazioniBatch = await pipeline.exec();
  }

  // 3. ESECUZIONE FILTRI (UNICA FONTE DI VERITÀ)
  // Il filtro ora restituisce corse già arricchite con 'postiDisponibili' corretto
  const { corse: corseValide } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  // 4. Gestione Slot Generici
  const allSlots = await Promise.all(
    Array.from(CacheStore.disponibilitaCache.values()).map(async (s) => {
      const stati = await getDisponibilita(s.driver_id, targetDate);
      const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
      return {
        ...s,
        disponibile: stati.some(st => st.disponibile),
        posti_totali: veicolo ? Number(veicolo.posti_totali || 0) : 0
      };
    })
  );
  
  const slotsLiberi = filterSlotOnly({ posti_richiesti: postiRichiesti }, allSlots);

  // 5. FUSIONE DEI RISULTATI (PULITA)
  const mapRisultati = new Map();

  // Aggiungiamo solo corse che hanno superato il filtro disponibilità
  corseValide.forEach(c => {
    mapRisultati.set(`corsa-${c.id}`, { ...c, is_slot: false });
  });

  // Aggiungiamo slot generici validi
  slotsLiberi.forEach(s => {
    mapRisultati.set(`slot-${s.id}`, { ...s, is_slot: true });
  });

  const risultatiFinali = Array.from(mapRisultati.values());
  console.log(`[SERVICE] Filtro completato: ${risultatiFinali.length} risultati trovati.`);

  if (risultatiFinali.length === 0) return [];

  // 6. Formattazione finale (Riceve dati già validati)
  try {
    return await formatResults(richiesta, risultatiFinali, corseValide, CacheStore.veicoliCache);
  } catch (err) {
    console.error("💥 [SERVICE] Errore in formatResults:", err);
    return []; 
  }
}