// Turentu - gestione turni conducenti (modulo indipendente)
// Tutte le funzioni ricevono un client pg già autorizzato dal chiamante.

function interoPositivo(value, nome) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${nome} non valido`);
  return n;
}

function validaOra(ora) {
  if (typeof ora !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(ora)) {
    throw new Error('Ora non valida (HH:MM o HH:MM:SS)');
  }
  return ora;
}

async function rapportoAttivo(client, operatoreId, rapportoId) {
  const { rows } = await client.query(
    `SELECT id, operatore_id, conducente_id
       FROM conducenti_operatori
      WHERE id = $1 AND operatore_id = $2 AND stato = 'attivo'`,
    [interoPositivo(rapportoId, 'rapportoId'), interoPositivo(operatoreId, 'operatoreId')]
  );
  if (!rows.length) throw new Error('Rapporto conducente non attivo o non appartenente all’operatore');
  return rows[0];
}

export async function elencoTurni(client, { operatoreId, rapportoId }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  const { rows } = await client.query(
    `SELECT id, rapporto_id, giorno_settimana, ora_inizio, ora_fine, fuso_orario, attivo
       FROM turni_conducenti WHERE rapporto_id = $1
      ORDER BY giorno_settimana, ora_inizio, id`,
    [rapportoId]
  );
  return rows;
}

export async function aggiungiTurno(client, { operatoreId, rapportoId, giornoSettimana, oraInizio, oraFine }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  const giorno = Number(giornoSettimana);
  if (!Number.isInteger(giorno) || giorno < 1 || giorno > 7) throw new Error('Giorno settimana non valido (1=lunedì, 7=domenica)');
  const inizio = validaOra(oraInizio);
  const fine = validaOra(oraFine);
  if (fine <= inizio) throw new Error('Il turno deve terminare nello stesso giorno e dopo l’inizio');
  const { rows } = await client.query(
    `INSERT INTO turni_conducenti (rapporto_id, giorno_settimana, ora_inizio, ora_fine, fuso_orario)
     VALUES ($1, $2, $3, $4, 'Europe/Rome') RETURNING *`,
    [rapportoId, giorno, inizio, fine]
  );
  return rows[0];
}

export async function impostaTurnoAttivo(client, { operatoreId, rapportoId, turnoId, attivo }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  if (typeof attivo !== 'boolean') throw new Error('attivo deve essere booleano');
  const { rows } = await client.query(
    `UPDATE turni_conducenti SET attivo = $1
      WHERE id = $2 AND rapporto_id = $3 RETURNING *`,
    [attivo, interoPositivo(turnoId, 'turnoId'), rapportoId]
  );
  if (!rows.length) throw new Error('Turno non trovato');
  return rows[0];
}

export async function eliminaTurno(client, { operatoreId, rapportoId, turnoId }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  const { rowCount } = await client.query(
    `DELETE FROM turni_conducenti WHERE id = $1 AND rapporto_id = $2`,
    [interoPositivo(turnoId, 'turnoId'), rapportoId]
  );
  if (!rowCount) throw new Error('Turno non trovato');
  return { eliminato: true };
}

export async function elencoEccezioni(client, { operatoreId, rapportoId }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  const { rows } = await client.query(
    `SELECT id, rapporto_id, lower(intervallo) AS inizio, upper(intervallo) AS fine, tipo, nota
       FROM eccezioni_turni_conducenti WHERE rapporto_id = $1
      ORDER BY lower(intervallo), id`,
    [rapportoId]
  );
  return rows;
}

export async function aggiungiEccezione(client, { operatoreId, rapportoId, inizio, fine, tipo, nota = null }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  if (!['disponibile', 'indisponibile'].includes(tipo)) throw new Error('Tipo eccezione non valido');
  const da = new Date(inizio);
  const a = new Date(fine);
  if (!Number.isFinite(da.getTime()) || !Number.isFinite(a.getTime()) || a <= da) {
    throw new Error('Intervallo eccezione non valido');
  }
  const { rows } = await client.query(
    `INSERT INTO eccezioni_turni_conducenti (rapporto_id, intervallo, tipo, nota)
     VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz, '[)'), $4, $5)
     RETURNING id, rapporto_id, lower(intervallo) AS inizio, upper(intervallo) AS fine, tipo, nota`,
    [rapportoId, da.toISOString(), a.toISOString(), tipo, nota]
  );
  return rows[0];
}

export async function eliminaEccezione(client, { operatoreId, rapportoId, eccezioneId }) {
  await rapportoAttivo(client, operatoreId, rapportoId);
  const { rowCount } = await client.query(
    `DELETE FROM eccezioni_turni_conducenti WHERE id = $1 AND rapporto_id = $2`,
    [interoPositivo(eccezioneId, 'eccezioneId'), rapportoId]
  );
  if (!rowCount) throw new Error('Eccezione non trovata');
  return { eliminata: true };
}
