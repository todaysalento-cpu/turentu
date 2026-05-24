// ======================= services/search/search.service.js =======================
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

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

  // DIAGNOSTICA: Controllo pre-filtro del veicolo specifico (es. ID 66)
  const veicoloTest = veicoliCache.find(v => v.id == 66);
  if (veicoloTest) {
    console.log(`📋 [DEBUG SERVICE] Veicolo 66 in cache:`, {
      posti_totali: veicoloTest.posti_totali,
      type_posti: typeof veicoloTest.posti_totali
    });
  }

  // 2. Filtra slot e corse compatibili
  // Passiamo i dati normalizzando i posti richiesti a numero
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

  // 4. Formattazione risultati
  const risultati = formatResults(richiesta, slots, corse, veicoliCache);
  
  console.log(`✅ [SERVICE] Risultati formattati pronti: ${risultati.length}`);
  return risultati;
}