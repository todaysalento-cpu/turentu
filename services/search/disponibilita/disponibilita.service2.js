// ======================= services/disponibilita/disponibilita.service.js =======================
import { pool } from '../../../db/db.js';

const WEEK_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

/**
 * Restituisce tutti i turni di un autista con stato disponibilità
 * @param {number} driver_id
 * @returns {Promise<Array>}
 */
export async function getDisponibilita(driver_id) {
  const res = await pool.query(
    `SELECT d.*, v.modello, v.targa 
     FROM disponibilita_veicolo d
     JOIN veicolo v ON v.id = d.veicolo_id
     WHERE v.driver_id = $1
     ORDER BY d.start`,
    [driver_id]
  );

  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Dom, 1=Lun, ...

  return res.rows.map(d => {
    let disponibile = true;

    // --- Controlla giorni esclusi
    if (Array.isArray(d.giorni_esclusi) && d.giorni_esclusi.includes(dayOfWeek)) {
      disponibile = false;
    }

    // --- Controlla inattività
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

    // --- Controlla se l'orario corrente rientra nel turno
    const startTime = new Date(d.start);
    const endTime = new Date(d.fine);
    if (now < startTime || now > endTime) {
      disponibile = false;
    }

    return {
      ...d,
      disponibile,
    };
  });
}

/**
 * Funzione helper: converte hh:mm o ISO string in timestamp ISO
 */
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  const oggi = new Date();
  const [hh, mm] = timeStr.split(':').map(Number);
  oggi.setHours(hh, mm, 0, 0);
  return oggi.toISOString();
}

/**
 * Crea o aggiorna un turno per un veicolo (upsert)
 * @param {Object} turno
 * @returns {Promise<Object>}
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
    [veicolo_id, start, fine, manual, giorni_esclusi, JSON.stringify(inattivita)]
  );

  return res.rows[0];
}

/**
 * Aggiorna un turno esistente
 * @param {number} id
 * @param {Object} update
 * @returns {Promise<Object>}
 */
export async function updateDisponibilita(id, update) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (update.start) update.start = parseTimeString(update.start);
  if (update.fine)  update.fine  = parseTimeString(update.fine);

  if (update.giorni_esclusi) {
    update.giorni_esclusi = update.giorni_esclusi.map(Number);
  }

  if (update.inattivita) {
    update.inattivita = JSON.stringify(update.inattivita);
  }

  for (const key in update) {
    fields.push(`${key} = $${idx}`);
    values.push(update[key]);
    idx++;
  }

  values.push(id);

  const res = await pool.query(
    `UPDATE disponibilita_veicolo SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`,
    values
  );

  return res.rows[0];
}

/**
 * Elimina un turno
 * @param {number} id
 */
export async function deleteDisponibilita(id) {
  await pool.query('DELETE FROM disponibilita_veicolo WHERE id=$1', [id]);
}
