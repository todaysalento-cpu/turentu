import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

const safeDate = (val) => {
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
};

/**
 * 1. FUNZIONE SINGOLA (Richiesta dal tuo Router)
 */
export async function getDisponibilita(veicoloId) {
  const risultati = await getDisponibilitaBatch([veicoloId]);
  return risultati.get(Number(veicoloId)) || [];
}

/**
 * 2. VERSIONE BATCH: Loggata per Debug
 */
export async function getDisponibilitaBatch(veicoloIds, targetDate = new Date(), impegniForti = []) {
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getUTCHours() * 60 + targetDate.getUTCMinutes();
  
  const results = new Map();

  for (const vId of veicoloIds) {
    const veicoloId = Number(vId);
    const turno = CacheStore.veicoloToDisponibilita.get(veicoloId);
    
    if (!turno) {
      console.log(`🔍 [DISP-DEBUG] Veicolo ${veicoloId}: Nessun turno trovato in CacheStore.`);
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

    // Valutazione disponibilità loggata
    const stato = (() => {
      // FIX LOGICO: assicuriamoci che tipo_corsa esista, altrimenti default a null
      const tipoCorsa = turno.tipo_corsa || null;
      
      console.log(`🔍 [DISP-DEBUG] V:${veicoloId} | Driver:${driverId} | Impegnato:${isImpegnatoInCorsaForte} | TipoCorsa:${tipoCorsa}`);

      if (isImpegnatoInCorsaForte && tipoCorsa !== 'pop-bus') {
        console.log(`❌ [DISP-DEBUG] Veicolo ${veicoloId} scartato: impegnato_corsa_forte.`);
        return { ...turno, disponibile: false, motivo: 'impegnato_corsa_forte' };
      }

      const giorniEsclusi = new Set((Array.isArray(turno.giorni_esclusi) ? turno.giorni_esclusi : []).map(Number));
      if (giorniEsclusi.has(targetDayOfWeek)) {
        console.log(`❌ [DISP-DEBUG] Veicolo ${veicoloId} scartato: giorno escluso.`);
        return { ...turno, disponibile: false };
      }

      if (Array.isArray(turno.inattivita)) {
        const isInactive = turno.inattivita.some(i => targetDate >= new Date(i.start) && targetDate <= new Date(i.fine));
        if (isInactive) {
            console.log(`❌ [DISP-DEBUG] Veicolo ${veicoloId} scartato: in pausa (inattività).`);
            return { ...turno, disponibile: false };
        }
      }

      const startM = toMinutes(turno.start);
      const endM = toMinutes(turno.fine);
      const disponibile = (startM > endM) 
        ? (targetMinutes >= startM || targetMinutes <= endM)
        : (targetMinutes >= startM && targetMinutes <= endM);

      if (!disponibile) console.log(`❌ [DISP-DEBUG] Veicolo ${veicoloId} scartato: fuori orario (${targetMinutes} min vs ${startM}-${endM}).`);
      
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

// --- CRUD OPERAZIONI (Resta intatto) ---
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