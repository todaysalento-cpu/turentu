import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { getDisponibilitaMap } from '../search.cache.js';

export async function getDisponibilita(driver_id) {
  const cacheMap = getDisponibilitaMap();
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
    throw new Error('Orario non valido: start deve essere prima di fine');
  }

  // Esegui inserimento
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

  // Recupera il driver_id per mantenere la cache coerente per il filtraggio futuro
  const vRes = await pool.query('SELECT driver_id FROM veicolo WHERE id = $1', [nuovoTurno.veicolo_id]);
  nuovoTurno.driver_id = vRes.rows[0]?.driver_id;

  console.log("[BACKEND] createDisponibilita - ID creato/aggiornato:", nuovoTurno.id, "per driver:", nuovoTurno.driver_id);
  
  CacheManager.disponibilita.update(nuovoTurno);
  return nuovoTurno;
}

export async function updateDisponibilita(id, update) {
  console.log(`[BACKEND] updateDisponibilita - ID: ${id}`);
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
  
  // Re-integra il driver_id
  const vRes = await pool.query('SELECT driver_id FROM veicolo WHERE id = $1', [turnoAggiornato.veicolo_id]);
  turnoAggiornato.driver_id = vRes.rows[0]?.driver_id;

  CacheManager.disponibilita.update(turnoAggiornato);
  return turnoAggiornato;
}

export async function deleteDisponibilita(id) {
  console.log(`[BACKEND] deleteDisponibilita - ID: ${id}`);
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