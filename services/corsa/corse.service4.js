import { pool } from '../../db/db.js';

// ----------------------
// 1️⃣ Recupera corse per autista (status opzionale)
// ----------------------
export async function getCorseByAutista(driver_id, status = '') {
  let query = `
    SELECT
      c.id,
      c.veicolo_id,
      v.driver_id,
      v.modello AS veicolo,
      c.tipo_corsa,
      c.start_datetime,
      c.arrivo_datetime,
      c.durata,
      ST_Y(c.origine::geometry) AS origine_lat,
      ST_X(c.origine::geometry) AS origine_lon,
      ST_Y(c.destinazione::geometry) AS destinazione_lat,
      ST_X(c.destinazione::geometry) AS destinazione_lon,
      c.origine_address,
      c.destinazione_address,
      c.stato,
      c.prezzo_fisso AS prezzo,
      c.posti_disponibili,
      c.posti_totali,
      c.posti_prenotati
    FROM corse c
    JOIN veicolo v ON c.veicolo_id = v.id
    WHERE v.driver_id = $1
  `;

  const params = [driver_id];

  if (status === 'today') {
    query += `
      AND c.start_datetime >= CURRENT_DATE
      AND c.start_datetime < CURRENT_DATE + INTERVAL '1 day'
    `;
  } else if (status === 'non_completate') {
    query += ` AND c.stato != 'completata'`;
  } else if (status) {
    query += ' AND c.stato = $2';
    params.push(status);
  }

  query += ' ORDER BY c.start_datetime ASC';

  const res = await pool.query(query, params);

  return res.rows.map(c => ({
    ...c,
    prezzo: Number(c.prezzo) || 0,
    veicolo_id: Number(c.veicolo_id),
    driver_id: Number(c.driver_id),
    origine: c.origine_lat != null && c.origine_lon != null ? { lat: c.origine_lat, lon: c.origine_lon } : null,
    destinazione: c.destinazione_lat != null && c.destinazione_lon != null ? { lat: c.destinazione_lat, lon: c.destinazione_lon } : null,
    origine_address: c.origine_address || 'N/D',
    destinazione_address: c.destinazione_address || 'N/D',
    arrivo_datetime: c.arrivo_datetime ? new Date(c.arrivo_datetime) : null,
    durata: c.durata || null,
    posti_prenotati: Number(c.posti_prenotati) || 0,
    ora: c.start_datetime ? new Date(c.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/D',
    data: c.start_datetime ? new Date(c.start_datetime).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'N/D',
  }));
}

// ----------------------
// 2️⃣ Accetta corsa
// ----------------------
export async function accettaCorsa(corsa_id) {
  const res = await pool.query(
    `UPDATE corse
     SET stato = 'accettata'
     WHERE id = $1
     RETURNING *`,
    [corsa_id]
  );

  const c = res.rows[0];
  if (!c) return null;

  return {
    ...c,
    arrivo_datetime: c.arrivo_datetime ? new Date(c.arrivo_datetime) : null,
    durata: c.durata || null,
    posti_prenotati: Number(c.posti_prenotati) || 0,
    prezzo: Number(c.prezzo_fisso) || 0,
    origine_address: c.origine_address || 'N/D',
    destinazione_address: c.destinazione_address || 'N/D',
  };
}

// ----------------------
// 3️⃣ Inizia/Termina corsa
// ----------------------
export async function toggleCorsa(corsa_id, action) {
  if (!['start', 'end'].includes(action)) throw new Error('Azione non valida');

  // Usa valori conformi al vincolo
  const newStato = action === 'start' ? 'in_corso' : 'completata';

  const res = await pool.query(
    `UPDATE corse
     SET stato = $1
     WHERE id = $2
     RETURNING *`,
    [newStato, corsa_id]
  );

  const c = res.rows[0];
  if (!c) return null;

  return {
    ...c,
    arrivo_datetime: c.arrivo_datetime ? new Date(c.arrivo_datetime) : null,
    durata: c.durata || null,
    posti_prenotati: Number(c.posti_prenotati) || 0,
    prezzo: Number(c.prezzo_fisso) || 0,
    origine_address: c.origine_address || 'N/D',
    destinazione_address: c.destinazione_address || 'N/D',
    stato: newStato, // ✅ stato corretto
  };
}