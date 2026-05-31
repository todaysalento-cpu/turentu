import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { redisClient } from '../redis.js'; // Assicurati che l'import sia corretto
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);

  // --- LOGICA DI RICERCA VELOCE O(1) ---
  // 1. Calcola il geohash del punto di richiesta
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  
  // 2. Recupera solo gli ID delle corse che passano in quest'area (incluso vicini)
  // Grazie all'indice inverso creato in upsertCorsa
  const candidateIds = await redisClient.sMembers(`corsa_in_area:${hash}`);
  
  // 3. Filtra le corse dalla cache basandosi solo sui candidati trovati
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  console.log(`DEBUG: Corse candidate trovate via indice Redis: ${corseCandidate.length}`);

  if (corseCandidate.length === 0) {
    console.log("⚠️ [SERVICE] Nessuna corsa transita in quest'area");
    return [];
  }

  const veicoli = Array.from(CacheStore.veicoliCache.values());
  const disponibilita = Array.from(CacheStore.disponibilitaCache.values());

  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: Number(richiesta.posti_richiesti),
    lat,
    lon
  };

  // --- FILTRO AVANZATO ---
  // Passiamo solo le corse candidate al motore di disponibilità
  const risultatoFiltro = await filterDisponibilita(
    richiestaNormalizzata,
    veicoli,
    disponibilita,
    corseCandidate // <- Solo le corse che passano di qui
  );

  const { slots, corse: corseCompatibili } = risultatoFiltro;

  console.log(`📊 [SERVICE] Filtro completato | Slots: ${slots?.length || 0} | Corse: ${corseCompatibili?.length || 0}`);
  
  if (!slots || slots.length === 0) {
    console.log("⚠️ [SERVICE] Nessun risultato compatibile trovato");
    return [];
  }

  try {
    const risultati = await formatResults(
      richiestaNormalizzata, 
      slots, 
      corseCompatibili, 
      CacheStore.veicoliCache 
    );
    
    const risultatiFinali = Array.isArray(risultati) ? risultati : [];
    console.log(`✅ [SERVICE] Risultati finali pronti: ${risultatiFinali.length}`);
    return risultatiFinali;
    
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico durante la formattazione:", err);
    return []; 
  }
}