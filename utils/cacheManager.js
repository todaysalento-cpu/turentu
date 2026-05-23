import { 
  upsertVeicolo, removeVeicolo,
  upsertCorsa, removeCorsa,
  upsertDisponibilita, removeDisponibilita
} from '../services/search/search.cache.js';

/**
 * Manager centralizzato per mantenere la cache in sincrono con il DB.
 * Usa questo modulo nei tuoi Service invece di chiamare direttamente la cache.
 */
export const CacheManager = {
  
  // --- VEICOLI ---
  veicolo: {
    update: (veicolo) => upsertVeicolo(veicolo),
    delete: (id) => removeVeicolo(id)
  },

  // --- CORSE ---
  corsa: {
    /**
     * @param {object} corsa - Oggetto ritornato da DB (con coordinate e campi calcolati)
     */
    update: (corsa) => {
      // Puoi aggiungere qui logica extra, ad esempio filtraggio o formattazione
      upsertCorsa(corsa);
    },
    delete: (id) => removeCorsa(id)
  },

  // --- DISPONIBILITÀ ---
  disponibilita: {
    update: (turno) => upsertDisponibilita(turno),
    delete: (id) => removeDisponibilita(id)
  }
};