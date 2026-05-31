import { 
  upsertVeicolo, removeVeicolo,
  upsertCorsa, removeCorsa,
  upsertDisponibilita, removeDisponibilita
} from '../services/search/search.cache.js';

/**
 * Manager centralizzato per mantenere la cache in sincrono con il DB.
 * Nota: Tutte le operazioni sono ora async per garantire la coerenza.
 */
export const CacheManager = {
  
  // --- VEICOLI ---
  veicolo: {
    update: async (veicolo) => await upsertVeicolo(veicolo),
    delete: async (id) => await removeVeicolo(id)
  },

  // --- CORSE ---
  corsa: {
    update: async (corsa) => {
      // Inseriamo l'await per garantire l'indicizzazione ZSET in Redis
      await upsertCorsa(corsa);
    },
    delete: async (id) => await removeCorsa(id)
  },

  // --- DISPONIBILITÀ ---
  disponibilita: {
    update: async (turno) => await upsertDisponibilita(turno),
    delete: async (id) => await removeDisponibilita(id)
  }
};