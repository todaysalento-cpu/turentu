import { pool } from '../../db/db.js';

// --- OGGETTO CONTENITORE SINGOLO ---
// Questo garantisce che l'oggetto esista sempre, anche se le Map al suo interno venissero create in un secondo momento
export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map()
};

export const TOP_RESULTS = 10;

// --- GETTER & FUNZIONI (Accedono sempre all'oggetto CacheStore) ---
export const getVeicoliMap = () => CacheStore.veicoliCache;
export const getDisponibilitaMap = () => CacheStore.disponibilitaCache;
export const getCorseMap = () => CacheStore.corseCache;
export const getPendingMap = () => CacheStore.pendingCache;

export const upsertVeicolo = (v) => {
  const oldData = CacheStore.veicoliCache.get(v.id) || {};
  CacheStore.veicoliCache.set(v.id, { ...oldData, ...v });
};

// ... (tutte le altre funzioni di upsert/remove devono usare CacheStore.nomeCache)

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.veicoliCache.size > 0 && CacheStore.corseCache.size > 0) return;

  const client = await pool.connect();
  try {
    // ... esegui le query normalmente ...
    // Esempio popola:
    // vRes.rows.forEach(v => upsertVeicolo(v)); 
    console.log(`📦 [CACHE] Sincronizzazione completata.`);
  } finally {
    client.release();
  }
}