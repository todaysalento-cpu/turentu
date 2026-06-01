import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { CacheStore } from '../search.cache.js';

/**
 * Valuta la disponibilità di un driver per una data specifica.
 * @param {number} driver_id 
 * @param {Date} targetDate - Data/ora della corsa richiesta
 */
export async function getDisponibilita(driver_id, targetDate = new Date()) {
  const cacheMap = CacheStore.disponibilitaCache;
  const tuttiITurni = Array.from(cacheMap.values());
  
  const turniDriver = tuttiITurni.filter(d => d.driver_id === driver_id);
  
  // Parametri di confronto per la richiesta specifica
  const targetDayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();

  return turniDriver.map(d => {
    let disponibile = true;
    
    // 1. Verifica GIORNI ESCLUSI (Data-Specific: controlla il giorno della settimana)
    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];
    if (giorniEsclusiNum.includes(targetDayOfWeek)) {
      disponibile = false;
    }

    // 2. Verifica PERIODI DI INATTIVITÀ (Data-Specific: confronto range date reali)
    if (disponibile && Array.isArray(d.inattivita)) {
      for (const i of d.inattivita) {
        const startInattivita = new Date(i.start);
        const fineInattivita = new Date(i.fine);
        if (targetDate >= startInattivita && targetDate <= fineInattivita) {
          disponibile = false;
          break;
        }
      }
    }

    // 3. Verifica ORARIO TURNO (Data-Agnostic: solo HH:mm)
    if (disponibile) {
      const start = new Date(d.start);
      const fine = new Date(d.fine);
      
      // Utilizzo di UTC per isolare l'orario dalla data (fissata al 1970-01-01)
      const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
      const endMinutes = fine.getUTCHours() * 60 + fine.getUTCMinutes();
      
      // Gestione turni a cavallo della mezzanotte (Overnight)
      const isOvernight = startMinutes > endMinutes;
      
      if (isOvernight) {
        if (!(targetMinutes >= startMinutes || targetMinutes <= endMinutes)) disponibile = false;
      } else {
        if (targetMinutes < startMinutes || targetMinutes > endMinutes) disponibile = false;
      }
    }

    return { ...d, disponibile };
  });
}

export async function createDisponibilita(turno) {
  let { veicolo_id, start, fine, manual = false, giorni_esclusi = [], inattivita = [] } = turno;

  start = parseTimeString(start);
  fine = parseTimeString(fine);

  if (!start || !fine || start >= fine) {
    throw new Error('Orario non valido: start deve essere prima di fine');
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

  let nuovoTurno = res.rows[0];
  const vRes = await pool.query('SELECT driver_id FROM veicolo WHERE id = $1', [nuovoTurno.veicolo_id]);
  nuovoTurno.driver_id = vRes.rows[0]?.driver_id;

  CacheManager.disponibilita.update({
    ...nuovoTurno,
    veicolo_id: Number(nuovoTurno.veicolo_id),
    is_slot: true,
    tipo: 'disponibilita'
  });
  
  return nuovoTurno;
}

export async function updateDisponibilita(id, update) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (update.start) update.start = parseTimeString(update.start);
  if (update.fine) update.fine = parseTimeString(update.fine);
  if (update.giorni_esclusi) update.giorni_esclusi = update.giorni_esclusi.map(Number);
  
  const payload = { ...update };
  if (payload.inattivita) payload.inattivita = JSON.stringify(payload.inattivita);

  for (const key in payload) {
    fields.push(`${key} = $${idx}`);
    values.push(payload[key]);
    idx++;
  }
  values.push(id);

  const res = await pool.query(
    `UPDATE disponibilita_veicolo SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`,
    values
  );

  let turnoAggiornato = res.rows[0];
  const vRes = await pool.query('SELECT driver_id FROM veicolo WHERE id = $1', [turnoAggiornato.veicolo_id]);
  turnoAggiornato.driver_id = vRes.rows[0]?.driver_id;

  CacheManager.disponibilita.update({
    ...turnoAggiornato,
    veicolo_id: Number(turnoAggiornato.veicolo_id),
    is_slot: true,
    tipo: 'disponibilita'
  });
  
  return turnoAggiornato;
}

export async function deleteDisponibilita(id) {
  await pool.query('DELETE FROM disponibilita_veicolo WHERE id=$1', [id]);
  CacheManager.disponibilita.delete(id);
}

/**
 * Parsa un orario in stringa (HH:mm) convertendolo in una data standard.
 * Forza la data al 1° Gennaio 1970 per rendere i confronti data-agnostic.
 */
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  
  const [hh, mm] = timeStr.split(':').map(Number);
  // La data 1970-01-01 è usata come riferimento neutro per ogni orario
  return new Date(1970, 0, 1, hh, mm, 0, 0).toISOString();
}