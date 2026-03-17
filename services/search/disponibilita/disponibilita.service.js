import { pool } from '../../../db/db.js';

/**
 * Restituisce tutti i turni di un autista con stato disponibilità
 * Considera:
 *  - giorni esclusi (solo per oggi)
 *  - periodi di inattività
 *  - orario del turno (ore e minuti)
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
  const dayOfWeek = now.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab
  const currentMinutes = now.getHours() * 60 + now.getMinutes(); // minuti totali oggi

  return res.rows.map(d => {
    let disponibile = true;

    // --- Giorni esclusi
    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi)
      ? Array.from(new Set(d.giorni_esclusi.map(Number)))
      : [];

    console.log('Veicolo:', d.veicolo_id, d.modello);
    console.log('Giorni esclusi DB:', d.giorni_esclusi, '=> convertiti:', giorniEsclusiNum);
    console.log('Giorno corrente (0=Dom):', dayOfWeek);

    if (giorniEsclusiNum.includes(dayOfWeek)) {
      console.log('→ Turno non disponibile per giorno escluso oggi');
      disponibile = false;
    } else if (giorniEsclusiNum.length >= 7) {
      console.log('→ Tutti i giorni esclusi → turno non disponibile');
      disponibile = false;
    }

    // --- Controlla periodi di inattività
    if (Array.isArray(d.inattivita)) {
      for (const i of d.inattivita) {
        const start = new Date(i.start);
        const end = new Date(i.fine);
        if (now >= start && now <= end) {
          console.log('→ Turno non disponibile per inattività:', i);
          disponibile = false;
          break;
        }
      }
    }

    // --- Controlla orario turno (solo ore e minuti)
    const startDate = new Date(d.start);
    const endDate = new Date(d.fine);
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
      console.log(`→ Turno non disponibile per orario. Ora corrente: ${currentMinutes} min, start: ${startMinutes}, end: ${endMinutes}`);
      disponibile = false;
    }

    console.log('Disponibile finale:', disponibile);
    console.log('---------------------------');

    return { ...d, disponibile };
  });
}

/**
 * Funzione helper: converte hh:mm o ISO string in timestamp ISO
 */
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr).toISOString();
  const today = new Date();
  const [hh, mm] = timeStr.split(':').map(Number);
  today.setHours(hh, mm, 0, 0);
  return today.toISOString();
}

/**
 * Crea o aggiorna un turno per un veicolo (upsert)
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
 */
export async function updateDisponibilita(id, update) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (update.start) update.start = parseTimeString(update.start);
  if (update.fine)  update.fine  = parseTimeString(update.fine);

  if (update.giorni_esclusi) update.giorni_esclusi = update.giorni_esclusi.map(Number);
  if (update.inattivita) update.inattivita = JSON.stringify(update.inattivita);

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
 */
export async function deleteDisponibilita(id) {
  await pool.query('DELETE FROM disponibilita_veicolo WHERE id=$1', [id]);
}
