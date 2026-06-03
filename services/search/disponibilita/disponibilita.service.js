import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

const safeDate = (val) => {
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
};

/**
 * VERSIONE AGGIORNATA: Lookup diretto tramite indice veicoloToDisponibilita
 */
export async function getDisponibilitaBatch(veicoloIds, targetDate = new Date(), impegniForti = []) {
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getUTCHours() * 60 + targetDate.getUTCMinutes();
  
  const results = new Map();

  for (const vId of veicoloIds) {
    const veicoloId = Number(vId);
    
    // ACCESSO DIRETTO: Ora usiamo la nuova mappa creata nel CacheStore
    const turno = CacheStore.veicoloToDisponibilita.get(veicoloId);
    
    if (!turno) {
      results.set(veicoloId, []); // Nessun turno trovato per questo veicolo
      continue;
    }

    const driverId = Number(turno.driver_id);
    
    // Verifica impegni "Forti"
    const isImpegnatoInCorsaForte = impegniForti.some(i => 
      Number(i.driver_id) === driverId && 
      targetDate >= safeDate(i.start_datetime) && 
      targetDate <= safeDate(i.arrivo_datetime)
    );

    // Valutazione disponibilità per il singolo turno trovato
    const stato = (() => {
      // 1. GESTIONE STATO DI OCCUPAZIONE
      if (isImpegnatoInCorsaForte && turno.tipo_corsa !== 'pop-bus') {
        return { ...turno, disponibile: false, motivo: 'impegnato_corsa_forte' };
      }

      // 2. LOGICA TURNI (Giorno)
      const giorniEsclusi = new Set((Array.isArray(turno.giorni_esclusi) ? turno.giorni_esclusi : []).map(Number));
      if (giorniEsclusi.has(targetDayOfWeek)) return { ...turno, disponibile: false };

      // 3. Verifica PERIODI DI INATTIVITÀ
      if (Array.isArray(turno.inattivita)) {
        const isInactive = turno.inattivita.some(i => targetDate >= new Date(i.start) && targetDate <= new Date(i.fine));
        if (isInactive) return { ...turno, disponibile: false };
      }

      // 4. VERIFICA ORARIO
      const startM = toMinutes(turno.start);
      const endM = toMinutes(turno.fine);
      const disponibile = (startM > endM) 
        ? (targetMinutes >= startM || targetMinutes <= endM)
        : (targetMinutes >= startM && targetMinutes <= endM);

      return { ...turno, disponibile };
    })();

    results.set(veicoloId, [stato]);
  }
  return results;
}

/**
 * Helper per estrarre minuti dal giorno in modo coerente (UTC)
 */
function toMinutes(timeStr) {
  const d = new Date(timeStr);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// --- CRUD OPERAZIONI ---
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
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0)).toISOString();
}