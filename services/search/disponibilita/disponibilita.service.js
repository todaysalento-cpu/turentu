import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
// IMPORTANTE: Assicurati di esportare getDisponibilitaMap da search.cache.js
import { getDisponibilitaMap } from '../search.cache.js'; 

export async function getDisponibilita(driver_id) {
  const cacheMap = getDisponibilitaMap(); 
  
  // Ora .size e .values() funzionano correttamente sulla Map
  const tuttiITurni = Array.from(cacheMap.values());
  
  console.log(`[BACKEND] getDisponibilita - Cache size: ${cacheMap.size}, Filtro driver_id: ${driver_id}`);
  
  const turniDriver = tuttiITurni.filter(d => d.driver_id === driver_id);
  console.log(`[BACKEND] getDisponibilita - Trovati ${turniDriver.length} turni per driver ${driver_id}`);

  const now = new Date();
  const dayOfWeek = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return turniDriver.map(d => {
    let disponibile = true;
    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];

    if (giorniEsclusiNum.includes(dayOfWeek) || giorniEsclusiNum.length >= 7) {
      disponibile = false;
    }

    if (Array.isArray(d.inattivita)) {
      for (const i of d.inattivita) {
        const start = new Date(i.start);
        const end = new Date(i.fine);
        if (now >= start && now <= end) {
          disponibile = false;
          break;
        }
      }
    }

    const startDate = new Date(d.start);
    const endDate = new Date(d.fine);
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();
    
    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
      disponibile = false;
    }

    return { ...d, disponibile };
  });
}

export async function createDisponibilita(turno) {
  console.log("[BACKEND] createDisponibilita - Ricevuto:", turno);
  let { veicolo_id, start, fine, manual = false, giorni_esclusi = [], inattivita = [] } = turno;

  start = parseTimeString(start);
  fine  = parseTimeString(fine);

  if (!start || !fine || start >= fine) {
    throw new Error('Orario non valido');
  }

  const res = await pool.query(
    `INSERT INTO disponibilita_veicolo
      (veicolo_id, start, fine, manual, giorni_esclusi, inattivita)
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
  console.log("[BACKEND] createDisponibilita - ID creato:", nuovoTurno.id);
  
  // Aggiorna la cache
  CacheManager.disponibilita.update(nuovoTurno);
  return nuovoTurno;
}

// ... (updateDisponibilita e deleteDisponibilita rimangono simili)
export async function updateDisponibilita(id, update) {
    // Stessa logica di prima...
    // Assicurati di usare CacheManager.disponibilita.update(turnoAggiornato);
}

export async function deleteDisponibilita(id) {
    await pool.query('DELETE FROM disponibilita_veicolo WHERE id=$1', [id]);
    CacheManager.disponibilita.delete(id);
}

function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  const today = new Date();
  const [hh, mm] = timeStr.split(':').map(Number);
  today.setHours(hh, mm, 0, 0);
  return today.toISOString();
}