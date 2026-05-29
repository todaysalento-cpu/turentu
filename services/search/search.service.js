// ======================= services/search/search.service.js =======================
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache, CacheStore } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

/**
 * Cerca slot e corse disponibili in base alla richiesta del cliente
 */
export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  // 1. Assicura che la cache sia caricata
  await loadCachesUltra();

  // 2. Lettura sincrona dalla memoria
  const veicoli = getVeicoliCache();
  const disponibilita = getDisponibilitaCache();
  const corse = getCorseCache();

  if (!veicoli || !disponibilita || !corse) {
    console.error("❌ [SERVICE] Errore: Cache non caricata correttamente");
    throw new Error('Cache non caricata correttamente');
  }

  // 3. Normalizzazione richiesta spaziale
  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: Number(richiesta.posti_richiesti),
    lat: Number(richiesta.coord?.lat ?? richiesta.lat),
    lon: Number(richiesta.coord?.lon ?? richiesta.lon)
  };

  // 4. Motore di ricerca dinamico
  const { slots, corse: corseCompatibili } = filterDisponibilita(
    richiestaNormalizzata,
    veicoli,
    disponibilita,
    corse
  );

  console.log(`📊 [SERVICE] Filtro completato | Slots: ${slots?.length || 0} | Corse: ${corseCompatibili?.length || 0}`);

  // 5. Controllo risultati
  if ((!slots || slots.length === 0) && (!corseCompatibili || corseCompatibili.length === 0)) {
    console.log("⚠️ [SERVICE] Nessun risultato compatibile trovato");
    return [];
  }

  // 6. Formattazione risultati
  try {
    // FIX: Passiamo la Map (CacheStore.veicoliCache) invece dell'array
    const risultati = await formatResults(
      richiestaNormalizzata, 
      slots, 
      corseCompatibili, 
      CacheStore.veicoliCache 
    );
    
    const risultatiFinali = Array.isArray(risultati) ? risultati : [];
    console.log(`✅ [SERVICE] Risultati pronti: ${risultatiFinali.length}`);
    return risultatiFinali;
    
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico durante la formattazione:", err);
    return []; 
  }
}

/**
 * Funzioni helper
 */
export async function cercaSlotPerCliente(clienteId, richiesta) {
  return await cercaSlotUltra(richiesta);
}

export async function cercaSlotPerAutista(veicoloId) {
  await loadCachesUltra();
  const corse = getCorseCache();
  if (!corse) return [];
  return corse.filter(c => c.veicolo_id == veicoloId);
}