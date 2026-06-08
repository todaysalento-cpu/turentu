import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

const safeDate = (val) => {
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
};

/**
 * 1. FUNZIONE SINGOLA
 */
export async function getDisponibilita(veicoloId) {
  const risultati = await getDisponibilitaBatch([veicoloId]);
  return risultati.get(Number(veicoloId)) || [];
}

/**
 * 2. VERSIONE BATCH: Con Log di Debug
 */
export async function getDisponibilitaBatch(veicoloIds, targetDate = new Date(), impegniForti = []) {
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getUTCHours() * 60 + targetDate.getUTCMinutes();
  
  const results = new Map();

  for (const vId of veicoloIds) {
    const veicoloId = Number(vId);
    const turno = CacheStore.veicoloToDisponibilita.get(veicoloId);
    
    if (!turno) {
      console.log(`🔍 [DISP-DEBUG] Veicolo ${veicoloId}: Turno NON trovato nel CacheStore.`);
      results.set(veicoloId, []); 
      continue;
    }

    const driverId = Number(turno.driver_id);
    
    // Verifica impegni "Forti"
    const isImpegnatoInCorsaForte = impegniForti.some(i => 
      Number(i.driver_id) === driverId && 
      targetDate >= safeDate(i.start_datetime) && 
      targetDate <= safeDate(i.arrivo_datetime)
    );

    // Valutazione disponibilità
    const stato = (() => {
      // Log di ingresso verifica
      console.log(`🔍 [DISP-DEBUG] Valutazione V:${veicoloId} | Driver:${driverId} | Impegnato:${isImpegnatoInCorsaForte}`);

      if (isImpegnatoInCorsaForte && turno.tipo_corsa !== 'pop-bus') {
        console.log(`❌ [DISP-DEBUG] V:${veicoloId} scartato: Impegno corsa forte rilevato.`);
        return { ...turno, disponibile: false, motivo: 'impegnato_corsa_forte' };
      }

      const giorniEsclusi = new Set((Array.isArray(turno.giorni_esclusi) ? turno.giorni_esclusi : []).map(Number));
      if (giorniEsclusi.has(targetDayOfWeek)) {
        console.log(`❌ [DISP-DEBUG] V:${veicoloId} scartato: Giorno ${targetDayOfWeek} escluso.`);
        return { ...turno, disponibile: false };
      }

      if (Array.isArray(turno.inattivita)) {
        const isInactive = turno.inattivita.some(i => targetDate >= new Date(i.start) && targetDate <= new Date(i.fine));
        if (isInactive) {
          console.log(`❌ [DISP-DEBUG] V:${veicoloId} scartato: In periodo di inattività.`);
          return { ...turno, disponibile: false };
        }
      }

      const startM = toMinutes(turno.start);
      const endM = toMinutes(turno.fine);
      const disponibile = (startM > endM) 
        ? (targetMinutes >= startM || targetMinutes <= endM)
        : (targetMinutes >= startM && targetMinutes <= endM);

      if (!disponibile) {
        console.log(`❌ [DISP-DEBUG] V:${veicoloId} scartato: Fuori orario (Target:${targetMinutes} vs Turno:${startM}-${endM}).`);
      } else {
        console.log(`✅ [DISP-DEBUG] V:${veicoloId} RISULTATO: Disponibile.`);
      }

      return { ...turno, disponibile };
    })();

    results.set(veicoloId, [stato]);
  }
  return results;
}

function toMinutes(timeStr) {
  const d = new Date(timeStr);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// --- CRUD OPERAZIONI ---
export async function createDisponibilita(turno) {
  let { veicolo_id, start, fine, manual = false, giorni_esclusi = [], inattivita = [] } = turno;
  
  start = parseTimeString(start);
  fine = parseTimeString(fine);

  if (!start || !fine || new Date(start) >= new Date(fine)) {
    throw new Error('Orario non valido');
  }

  const res = await pool.query(
    `INSERT INTO disponibilita_veicolo (veicolo_id, start, fine, manual, giorni_esclusi, inattivita)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (veicolo_id)
     DO UPDATE SET 
        start = EXCLUDED.start, 
        fine = EXCLUDED.fine, 
        manual = EXCLUDED.manual, 
        giorni_esclusi = EXCLUDED.giorni_esclusi, 
        inattivita = EXCLUDED.inattivita
     RETURNING *`,
    [veicolo_id, start, fine, manual, giorni_esclusi.map(Number), JSON.stringify(inattivita)]
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