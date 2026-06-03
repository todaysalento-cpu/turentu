import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

const safeDate = (val) => {
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
};

/**
 * VERSIONE AGGIORNATA: Gestione Pool Dinamico
 */
export async function getDisponibilitaBatch(driverIds, targetDate = new Date(), impegniForti = []) {
  const tuttiITurni = Array.from(CacheStore.disponibilitaCache.values());
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();
  
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
    
    // Verifica impegni "Forti" (Privata/Condivisa che blocca il driver)
    const isImpegnatoInCorsaForte = impegniForti.some(i => 
      Number(i.driver_id) === dId && 
      targetDate >= safeDate(i.start_datetime) && 
      targetDate <= safeDate(i.arrivo_datetime)
    );
    
    const stati = turniDriver.map(d => {
      // 1. GESTIONE STATO DI OCCUPAZIONE:
      // Se il driver è in una corsa forte, NON può fare 'privata' o 'condivisa'.
      // Tuttavia, il sistema permette di mantenere il driver nel "Pool Pop Bus" 
      // anche se ha impegni, a patto che il turno sia specificamente 'pop-bus'.
      if (isImpegnatoInCorsaForte && d.tipo_corsa !== 'pop-bus') {
        return { ...d, disponibile: false, motivo: 'impegnato_corsa_forte' };
      }

      // 2. LOGICA TURNI (Giorno ed Orario)
      const giorniEsclusi = new Set((Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi : []).map(Number));
      if (giorniEsclusi.has(targetDayOfWeek)) return { ...d, disponibile: false };

      // 3. Verifica PERIODI DI INATTIVITÀ
      if (Array.isArray(d.inattivita)) {
        for (const i of d.inattivita) {
          if (targetDate >= safeDate(i.start) && targetDate <= safeDate(i.fine)) {
            return { ...d, disponibile: false };
          }
        }
      }

      // 4. VERIFICA ORARIO
      const startM = parseMinutes(d.start);
      const endM = parseMinutes(d.fine);
      const disponibile = (startM > endM) 
        ? (targetMinutes >= startM || targetMinutes <= endM)
        : (targetMinutes >= startM && targetMinutes <= endM);

      return { ...d, disponibile };
    });

    results.set(dId, stati);
  }
  return results;
}

// Helper dedicato per parsing orario
function parseMinutes(timeStr) {
    const d = new Date(timeStr);
    return d.getHours() * 60 + d.getMinutes();
}

// --- CRUD OPERAZIONI ---
// (Invariate, assicurano la persistenza del tipo_corsa anche per i turni pop-bus)
export async function createDisponibilita(turno) {
  let { veicolo_id, start, fine, tipo_corsa = 'privata', manual = false, giorni_esclusi = [], inattivita = [] } = turno;
  
  start = parseTimeString(start);
  fine = parseTimeString(fine);

  if (!start || !fine || new Date(start) >= new Date(fine)) {
    throw new Error('Orario non valido');
  }

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
  return new Date(1970, 0, 1, hh, mm, 0, 0).toISOString();
}