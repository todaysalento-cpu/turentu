function errore(status, message) {
  return Object.assign(new Error(message), { status });
}

function testo(value, campo, max, opzionale = false) {
  if (opzionale && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw errore(400, `${campo} non valido`);
  }
  return value.trim();
}

function orario(value, campo) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw errore(400, `${campo} richiede una data ISO con fuso orario`);
  }
  const giorno = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(giorno.getTime()) || giorno.toISOString().slice(0, 10) !== value.slice(0, 10) ||
      Number(value.slice(11, 13)) > 23 || value.startsWith('0000')) {
    throw errore(400, `${campo} non valido`);
  }
  return new Date(value).toISOString();
}

function intero(value, campo, minimo, massimo) {
  if (!Number.isInteger(value) || value < minimo || value > massimo) {
    throw errore(400, `${campo} non valido`);
  }
  return value;
}

function numeroVolo(value) {
  const numero = testo(value, 'Numero volo', 16).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z0-9]{2,3}\d{1,5}[A-Z]?$/.test(numero)) {
    throw errore(400, 'Numero volo non valido');
  }
  return numero;
}

export function datiPrenotazione(body) {
  const dati = body ?? {};
  const volo = dati.volo;
  let campiVolo = [null, null, null, null];
  if (volo != null) {
    const aeroporto = testo(volo.aeroporto, 'Aeroporto', 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(aeroporto) || !['arrivo', 'partenza'].includes(volo.direzione)) {
      throw errore(400, 'Aeroporto o direzione del volo non validi');
    }
    campiVolo = [
      numeroVolo(volo.numero), aeroporto, volo.direzione,
      orario(volo.programmatoIl, 'Orario programmato del volo')
    ];
  }
  return [
    testo(dati.cliente, 'Cliente', 160),
    testo(dati.recapito, 'Recapito', 160, true),
    testo(dati.origine, 'Origine', 250),
    testo(dati.destinazione, 'Destinazione', 250),
    orario(dati.prelievoIl, 'Orario di prelievo'),
    intero(dati.passeggeri, 'Passeggeri', 1, 2147483647),
    testo(dati.bagagli, 'Bagagli', 500, true),
    dati.prezzoCentesimi == null ? null : intero(dati.prezzoCentesimi, 'Prezzo in centesimi', 0, 2147483647),
    ...campiVolo
  ];
}

const campi = `id, cliente, recapito, origine, destinazione, prelievo_il, passeggeri,
  bagagli, prezzo_centesimi, volo_numero, volo_aeroporto, volo_direzione,
  volo_programmato_il, volo_aggiornato_il, annullata_il, creata_il, aggiornata_il,
  CASE WHEN volo_numero IS NOT NULL THEN 'manuale' END AS volo_fonte`;

export async function elencaPrenotazioniEsterne(pool, operatore, query) {
  const dal = query.dal == null ? null : orario(query.dal, 'Inizio intervallo');
  const al = query.al == null ? null : orario(query.al, 'Fine intervallo');
  if (dal && al && dal >= al) throw errore(400, 'Intervallo non valido');
  const volo = query.volo == null ? null : numeroVolo(query.volo);
  const offset = query.offset == null ? 0 : intero(Number(query.offset), 'Offset', 0, 2147483647);
  const { rows } = await pool.query(
    `SELECT ${campi} FROM public.ncc_prenotazioni_esterne
     WHERE operatore_id = $1
       AND ($2::timestamptz IS NULL OR prelievo_il >= $2)
       AND ($3::timestamptz IS NULL OR prelievo_il < $3)
       AND ($4::text IS NULL OR volo_numero = $4)
     ORDER BY prelievo_il, id LIMIT 101 OFFSET $5`,
    [operatore, dal, al, volo, offset]
  );
  return { prenotazioni: rows.slice(0, 100), prossimoOffset: rows.length > 100 ? offset + 100 : null };
}

export async function creaPrenotazioneEsterna(pool, operatore, body, importHash = null) {
  const { rows } = await pool.query(
    `INSERT INTO public.ncc_prenotazioni_esterne
       (operatore_id, cliente, recapito, origine, destinazione, prelievo_il, passeggeri,
        bagagli, prezzo_centesimi, volo_numero, volo_aeroporto, volo_direzione,
        volo_programmato_il, volo_aggiornato_il${importHash ? ", import_hash" : ""})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::varchar, $11, $12, $13,
       CASE WHEN $10::varchar IS NOT NULL THEN now() END${importHash ? ", $14" : ""})
     ${importHash ? "ON CONFLICT (operatore_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING" : ""}
     RETURNING ${campi}`,
    [operatore, ...datiPrenotazione(body), ...(importHash ? [importHash] : [])]
  );
  return rows[0];
}

export async function modificaPrenotazioneEsterna(pool, operatore, id, body) {
  const { rows } = await pool.query(
    `UPDATE public.ncc_prenotazioni_esterne
     SET cliente = $3, recapito = $4, origine = $5, destinazione = $6, prelievo_il = $7,
       passeggeri = $8, bagagli = $9, prezzo_centesimi = $10, volo_numero = $11::varchar,
       volo_aeroporto = $12, volo_direzione = $13, volo_programmato_il = $14,
       volo_aggiornato_il = CASE WHEN $11::varchar IS NULL THEN NULL
         WHEN ROW(volo_numero, volo_aeroporto, volo_direzione, volo_programmato_il)
           IS DISTINCT FROM ROW($11::varchar, $12::varchar, $13::varchar, $14::timestamptz)
         THEN now() ELSE volo_aggiornato_il END,
       aggiornata_il = now()
     WHERE operatore_id = $1 AND id = $2 AND annullata_il IS NULL
     RETURNING ${campi}`,
    [operatore, id, ...datiPrenotazione(body)]
  );
  if (!rows[0]) throw errore(404, 'Prenotazione attiva non trovata');
  return rows[0];
}

export async function annullaPrenotazioneEsterna(pool, operatore, id) {
  const { rows } = await pool.query(
    `UPDATE public.ncc_prenotazioni_esterne
     SET annullata_il = COALESCE(annullata_il, now()),
       aggiornata_il = CASE WHEN annullata_il IS NULL THEN now() ELSE aggiornata_il END
     WHERE operatore_id = $1 AND id = $2
     RETURNING ${campi}`,
    [operatore, id]
  );
  if (!rows[0]) throw errore(404, 'Prenotazione non trovata');
  return rows[0];
}

export async function eliminaPrenotazioneEsterna(pool, operatore, id) {
  await eliminaPrenotazioniEsterne(pool, operatore, [id]);
  return { id };
}

export async function eliminaPrenotazioniEsterne(pool, operatore, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n)) {
    throw errore(400, 'Seleziona da 1 a 100 prenotazioni valide.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(22022, $1::integer)', [operatore]);
    const { rows } = await client.query(
      `SELECT p.id, EXISTS (
         SELECT 1 FROM public.ncc_gruppi_approvati g
         WHERE g.operatore_id = p.operatore_id AND p.id = ANY(g.prenotazioni)
       ) AS approvata
       FROM public.ncc_prenotazioni_esterne p
       WHERE p.operatore_id = $1 AND p.id = ANY($2::bigint[])
       ORDER BY p.id FOR UPDATE OF p`, [operatore, ids]
    );
    if (rows.length !== ids.length) throw errore(404, 'Una o più prenotazioni non sono disponibili. Aggiorna la lista.');
    const bloccate = rows.filter(row => row.approvata);
    if (bloccate.length) {
      throw errore(409, 'Rimuovi prima i gruppi approvati delle prenotazioni ' + bloccate.map(row => '#' + row.id).join(', ') + '.');
    }
    const { rowCount } = await client.query(
      'DELETE FROM public.ncc_prenotazioni_esterne WHERE operatore_id = $1 AND id = ANY($2::bigint[])',
      [operatore, ids]
    );
    if (rowCount !== ids.length) throw errore(409, 'Le prenotazioni sono cambiate. Aggiorna la lista.');
    await client.query('COMMIT');
    return { eliminate: rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
