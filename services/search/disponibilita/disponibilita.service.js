import { pool } from '../../../db/db.js';
import { CacheManager } from '../../../utils/cacheManager.js';
import { getDisponibilitaCache } from '../search.cache.js';

/**
 * Restituisce tutti i turni di un autista. 
 * Ora utilizza la cache in memoria per una risposta istantanea.
 */
export async function getDisponibilita(driver_id) {
  // Accesso alla Map di cache
  const tuttiITurni = Array.from(getDisponibilitaCache().values());
  
  // Filtriamo i turni associati a questo driver
  const turniDriver = tuttiITurni.filter(d => d.driver_id === driver_id);

  const now = new Date();
  const dayOfWeek = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return turniDriver.map(d => {
    let disponibile = true;

    // --- Normalizza giorni esclusi
    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) 
      ? d.giorni_esclusi.map(Number) 
      : [];

    if (giorniEsclusiNum.includes(dayOfWeek) || giorniEsclusiNum.length >= 7) {
      disponibile = false;
    }

    // --- Controlla periodi di inattività
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

    // --- Controlla orario turno
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

/**
 * Crea o aggiorna un turno con logica Write-Through Cache
 */
export async function createDisponibilita(turno) {
  let { veicolo_id, start, fine, manual = false, giorni_esclusi = [], inattivita = [] } = turno;

  start = parseTimeString(start);
  fine  = parseTimeString(fine);

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

  const nuovoTurno = res.rows[0];
  
  // ✅ Aggiornamento Cache
  CacheManager.disponibilita.update(nuovoTurno);

  return nuovoTurno;
}

/**
 * Aggiorna un turno esistente e la cache
 */
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

  const turnoAggiornato = res.rows[0];
  
  // ✅ Aggiornamento Cache
  CacheManager.disponibilita.update(turnoAggiornato);

  return turnoAggiornato;
}

/**
 * Elimina un turno e rimuove dalla cache
 */
export async function deleteDisponibilita(id) {
  await pool.query('DELETE FROM disponibilita_veicolo WHERE id=$1', [id]);
  
  // ✅ Rimozione Cache
  CacheManager.disponibilita.delete(id);
}

/**
 * Helper: converte hh:mm o ISO string in timestamp ISO
 */
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  const today = new Date();
  const [hh, mm] = timeStr.split(':').map(Number);
  today.setHours(hh, mm, 0, 0);
  return today.toISOString();
}