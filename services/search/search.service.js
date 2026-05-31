import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const veicoli = Array.from(CacheStore.veicoliCache.values());
  const disponibilita = Array.from(CacheStore.disponibilitaCache.values());
  const corse = Array.from(CacheStore.corseCache.values());

  if (!veicoli || !disponibilita || !corse) {
    throw new Error('Cache non caricata correttamente');
  }

  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: Number(richiesta.posti_richiesti),
    lat: Number(richiesta.coord?.lat ?? richiesta.lat),
    lon: Number(richiesta.coord?.lon ?? richiesta.lon)
  };

  // --- DIAGNOSTICA: Controllo pre-filtro ---
  console.log(`DEBUG: Corse totali in memoria: ${corse.length}`);

  const risultatoFiltro = await filterDisponibilita(
    richiestaNormalizzata,
    veicoli,
    disponibilita,
    corse
  );

  const { slots, corse: corseCompatibili } = risultatoFiltro;

  // --- DIAGNOSTICA: Ispezione risultato filtro ---
  console.log(`📊 [SERVICE] Filtro completato | Slots: ${slots?.length || 0} | Corse: ${corseCompatibili?.length || 0}`);
  
  if (corseCompatibili?.length > 0) {
      console.log(`DEBUG: Esempio corsa compatibile (ID: ${corseCompatibili[0].id})`);
  }

  if ((!slots || slots.length === 0) && (!corseCompatibili || corseCompatibili.length === 0)) {
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