import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

/**
 * Helper robusto per date
 */
const safeDate = (val) => {
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
};

/**
 * VERSIONE OTTIMIZZATA: Valuta la disponibilità di più driver in un unico batch.
 */
export async function getDisponibilitaBatch(driverIds, targetDate = new Date()) {
  const tuttiITurni = Array.from(CacheStore.disponibilitaCache.values());
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();
  
  const results = new Map();

  for (const driverId of driverIds) {
    // Filtro garantito: assicurati che nella tua inizializzazione cache 
    // tu stia iniettando il driver_id correttamente.
    const turniDriver = tuttiITurni.filter(d => Number(d.driver_id) === Number(driverId));
    
    const stati = turniDriver.map(d => {
      let disponibile = true;

      // 1. Verifica GIORNI ESCLUSI
      const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];
      if (giorniEsclusiNum.includes(targetDayOfWeek)) disponibile = false;

      // 2. Verifica PERIODI DI INATTIVITÀ
      if (disponibile && Array.isArray(d.inattivita)) {
        for (const i of d.inattivita) {
          if (targetDate >= safeDate(i.start) && targetDate <= safeDate(i.fine)) {
            disponibile = false;
            break;
          }
        }
      }

      // 3. Verifica ORARIO (Uso di Date locali per confronto coerente)
      if (disponibile) {
        const start = safeDate(d.start);
        const fine = safeDate(d.fine);
        const startM = start.getHours() * 60 + start.getMinutes();
        const endM = fine.getHours() * 60 + fine.getMinutes();
        
        if (startM > endM) {
          if (!(targetMinutes >= startM || targetMinutes <= endM)) disponibile = false;
        } else {
          if (targetMinutes < startM || targetMinutes > endM) disponibile = false;
        }
      }
      return { ...d, disponibile };
    });

    results.set(driverId, stati);
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

  // Eseguiamo l'insert e recuperiamo subito il driver_id con una JOIN
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
  nuovoTurno.driver_id = driverRes.rows[0]?.driver_id;

  CacheManager.disponibilita.update({
    ...nuovoTurno,
    veicolo_id: Number(nuovoTurno.veicolo_id),
    driver_id: nuovoTurno.driver_id, // Fondamentale per il filtro
    is_slot: true,
    tipo: 'disponibilita',
    tipo_corsa: nuovoTurno.tipo_corsa
  });
  
  return nuovoTurno;
}

// ... (updateDisponibilita e deleteDisponibilita restano simili, ma ricorda di iniettare driver_id nel CacheManager.update) ...

function parseTimeString(timeStr) {
  if (!timeStr) return null;
  // Se è già un ISO string o contiene T, gestiscilo come data
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  
  const [hh, mm] = timeStr.split(':').map(Number);
  const date = new Date(1970, 0, 1, hh, mm, 0, 0);
  return date.toISOString();
}