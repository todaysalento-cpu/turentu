import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

/**
 * 1. FUNZIONE SINGOLA
 */
export async function getDisponibilita(veicoloId) {
  const risultati = await getDisponibilitaBatch([veicoloId]);
  return risultati.get(Number(veicoloId)) || [];
}

/**
 * 2. VERSIONE BATCH: Logica oraria con eccezione Pop-Bus
 */
export async function getDisponibilitaBatch(veicoloIds, targetDate = new Date(), impegniForti = []) {
  const targetMinutes = targetDate.getUTCHours() * 60 + targetDate.getUTCMinutes();
  const results = new Map();

  for (const vId of veicoloIds) {
    const veicoloId = Number(vId);
    const turno = CacheStore.veicoloToDisponibilita.get(veicoloId);
    
    if (!turno) {
      console.log(`🔍 [DISP-DEBUG] Veicolo ${veicoloId}: NON trovato in CacheStore.`);
      results.set(veicoloId, []); 
      continue;
    }

    // LOG DI ISPEZIONE TIPO
    // Verifica se il tipo è stato corrotto da 'disponibilita'
    const isPopBus = String(turno.tipo).toLowerCase().includes('pop-bus');
    console.log(`🔍 [DISP-DEBUG] Valutazione V:${veicoloId} | Tipo rilevato: '${turno.tipo}' | IsPopBus: ${isPopBus}`);

    const driverId = Number(turno.driver_id);
    const isImpegnatoInCorsaForte = impegniForti.some(i => 
      Number(i.driver_id) === driverId && 
      targetDate >= new Date(i.start_datetime) && 
      targetDate <= new Date(i.arrivo_datetime)
    );

    const stato = (() => {
      if (isImpegnatoInCorsaForte && !isPopBus) {
        return { ...turno, disponibile: false, motivo: 'impegnato_corsa_forte' };
      }

      // LOGICA ORARIA (Eccezione: I Pop-Bus sono sempre disponibili per il motore di ricerca)
      const startM = toMinutes(turno.start);
      const endM = toMinutes(turno.fine);
      
      const disponibile = isPopBus ? true : (
        (startM > endM) 
          ? (targetMinutes >= startM || targetMinutes <= endM)
          : (targetMinutes >= startM && targetMinutes <= endM)
      );

      if (!disponibile) {
        console.log(`❌ [DISP-DEBUG] V:${veicoloId} SCARTATO: Fuori orario (Target:${targetMinutes} vs Turno:${startM}-${endM}).`);
      } else {
        console.log(`✅ [DISP-DEBUG] V:${veicoloId} PASSATO: Disponibile.`);
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

  if (!start || !fine) throw new Error('Orario non valido');

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
  // RECUPERO TIPO ORIGINALE PER NON SOVRASCRIVERLO
  const veicoloRes = await pool.query('SELECT driver_id, servizi FROM veicolo WHERE id = $1', [veicolo_id]);
  const veicoloInfo = veicoloRes.rows[0];
  
  const finalTurno = {
    ...nuovoTurno,
    driver_id: veicoloInfo?.driver_id,
    tipo: veicoloInfo?.servizi || 'privata', // MANTENIAMO IL TIPO CORRETTO
    is_slot: true
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