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
  
  const dayOfWeek = targetDate.getDay();
  const targetMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();

  return turniDriver.map(d => {
    let disponibile = true;
    
    // 1. Verifica giorni esclusi
    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];
    if (giorniEsclusiNum.includes(dayOfWeek) || giorniEsclusiNum.length >= 7) {
      disponibile = false;
    }

    // 2. Verifica periodi di inattività
    if (disponibile && Array.isArray(d.inattivita)) {
      for (const i of d.inattivita) {
        const start = new Date(i.start);
        const end = new Date(i.fine);
        if (targetDate >= start && targetDate <= end) {
          disponibile = false;
          break;
        }
      }
    }

    // 3. Verifica orario turno (Data-agnostic: confronto basato solo su HH:mm)
    const startDate = new Date(d.start);
    const endDate = new Date(d.fine);
    
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();
    
    // Supporto per turni che superano la mezzanotte
    const isOvernight = startMinutes > endMinutes;
    
    if (disponibile) {
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

function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  const today = new Date();
  const [hh, mm] = timeStr.split(':').map(Number);
  today.setHours(hh, mm, 0, 0);
  return today.toISOString();
}