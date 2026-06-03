import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

/**
 * Helper robusto per date: forza il confronto a 0 se la data è invalida
 */
const safeDate = (val) => {
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
};

/**
 * VERSIONE OTTIMIZZATA: Utilizza una Map per il look-up O(1) invece di filtrare l'intero array.
 */
export async function getDisponibilitaBatch(driverIds, targetDate = new Date()) {
  const tuttiITurni = Array.from(CacheStore.disponibilitaCache.values());
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();
  
  // PRE-INDICIZZAZIONE: Raggruppiamo i turni per driverId (O(N))
  const turniMap = new Map();
  for (const turno of tuttiITurni) {
    const dId = Number(turno.driver_id);
    if (!turniMap.has(dId)) turniMap.set(dId, []);
    turniMap.get(dId).push(turno);
  }

  const results = new Map();

  for (const driverId of driverIds) {
    const dId = Number(driverId);
    const turniDriver = turniMap.get(dId) || [];
    
    const stati = turniDriver.map(d => {
      // 1. Verifica GIORNI ESCLUSI (Set per look-up rapido)
      const giorniEsclusi = new Set((Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi : []).map(Number));
      if (giorniEsclusi.has(targetDayOfWeek)) return { ...d, disponibile: false };

      // 2. Verifica PERIODI DI INATTIVITÀ
      if (Array.isArray(d.inattivita)) {
        for (const i of d.inattivita) {
          if (targetDate >= safeDate(i.start) && targetDate <= safeDate(i.fine)) {
            return { ...d, disponibile: false };
          }
        }
      }

      // 3. Verifica ORARIO
      const start = new Date(d.start);
      const fine = new Date(d.fine);
      const startM = start.getHours() * 60 + start.getMinutes();
      const endM = fine.getHours() * 60 + fine.getMinutes();
      
      const disponibile = (startM > endM) 
        ? (targetMinutes >= startM || targetMinutes <= endM)
        : (targetMinutes >= startM && targetMinutes <= endM);

      return { ...d, disponibile };
    });

    results.set(dId, stati);
  }
  return results;
}

// --- CRUD OPERAZIONI ---

export async function createDisponibilita(turno) {
  let { veicolo_id, start, fine, tipo_corsa = 'privata', manual = false, giorni_esclusi = [], inattivita = [] } = turno;

  start = parseTimeString(start);
  fine = parseTimeString(fine);

  if (!start || !fine || new Date(start) >= new Date(fine)) {
    throw new Error('Orario non valido: start deve essere prima di fine');
  }

  // Eseguiamo l'insert
  const res = await pool.query(
    `INSERT INTO disponibilita_veicolo (veicolo_id, start, fine, tipo_corsa, manual, giorni_esclusi, inattivita)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (veicolo_id)
     DO UPDATE SET start = EXCLUDED.start, fine = EXCLUDED.fine, tipo_corsa = EXCLUDED.tipo_corsa, 
                   manual = EXCLUDED.manual, giorni_esclusi = EXCLUDED.giorni_esclusi, inattivita = EXCLUDED.inattivita
     RETURNING *`,
    [veicolo_id, start, fine, tipo_corsa, manual, giorni_esclusi.map(Number), JSON.stringify(inattivita)]
  );

  const nuovoTurno = res.rows[0];
  const driverRes = await pool.query('SELECT driver_id FROM veicolo WHERE id = $1', [veicolo_id]);
  
  const finalTurno = {
    ...nuovoTurno,
    driver_id: driverRes.rows[0]?.driver_id,
    is_slot: true,
    tipo: 'disponibilita'
  };

  // Aggiornamento cache con dati normalizzati
  CacheManager.disponibilita.update({
    ...finalTurno,
    veicolo_id: Number(finalTurno.veicolo_id),
    driver_id: Number(finalTurno.driver_id)
  });
  
  return finalTurno;
}

function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  
  const [hh, mm] = timeStr.split(':').map(Number);
  // Usa il 1970 per gestire solo l'orario come confronto temporale
  return new Date(1970, 0, 1, hh, mm, 0, 0).toISOString();
}