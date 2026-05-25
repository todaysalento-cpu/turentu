// ======================= services/search/search.service.js =======================
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

/**
 * Cerca slot e corse disponibili in base alla richiesta del cliente
 */
export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca slot | Richiesta posti: ${richiesta.posti_richiesti}`);
  
  // 1. Assicura che la cache sia caricata
  await loadCachesUltra();

  const veicoliCache = await getVeicoliCache();
  const disponibilitaCache = await getDisponibilitaCache();
  const corseCache = await getCorseCache();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    console.error("❌ [SERVICE] Errore: Cache non caricata correttamente");
    throw new Error('Cache non caricata correttamente');
  }

  // DIAGNOSTICA: Controllo pre-filtro del veicolo specifico
  const veicoloTest = veicoliCache.find(v => v.id == 66);
  if (veicoloTest) {
    console.log(`📋 [DEBUG SERVICE] Veicolo 66 in cache:`, {
      posti_totali: veicoloTest.posti_totali,
      type_posti: typeof veicoloTest.posti_totali
    });
  }

  // 2. Filtra slot e corse compatibili
  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: Number(richiesta.posti_richiesti)
  };

  const { slots, corse } = filterDisponibilita(
    richiestaNormalizzata,
    veicoliCache,
    disponibilitaCache,
    corseCache
  );

  console.log(`📊 [SERVICE] Filtro completato | Slots trovati: ${slots?.length || 0} | Corse trovate: ${corse?.length || 0}`);

  // 3. Controllo risultati
  if ((!slots || slots.length === 0) && (!corse || corse.length === 0)) {
    console.log("⚠️ [SERVICE] Nessun risultato compatibile trovato");
    return [];
  }

  // 4. Formattazione risultati (Corretto: aggiunto await)
  try {
    const risultati = await formatResults(richiestaNormalizzata, slots, corse, veicoliCache);
    
    // Validazione finale: assicuriamoci di ritornare un array
    const risultatiFinali = Array.isArray(risultati) ? risultati : [];
    
    console.log(`✅ [SERVICE] Risultati formattati pronti: ${risultatiFinali.length}`);
    return risultatiFinali;
    
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico durante la formattazione:", err);
    return []; // Ritorniamo array vuoto in caso di errore per non far crashare la UI
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
  const corseCache = await getCorseCache();
  if (!corseCache) return [];
  return corseCache.filter(c => c.veicolo_id === veicoloId);
}