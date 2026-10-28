// TURENTU — POPBUS V2
// Indice SHADOW degli impegni fisici dei veicoli.
//
// Replica la semantica della funzione conflicts()
// di pixel-first-multimission-service.js.
//
// Nessuna scrittura DB.
// Nessuna dipendenza dalle direttrici_virtuali.
// Nessuna esclusione basata su tipi_veicolo_ammessi.
//
// IMPORTANTE:
// L'indice rappresenta uno snapshot degli impegni.
// Non sostituisce la rivalidazione transazionale finale.

const STATI_ATTIVAZIONE = [
  'in_attesa_autista',
  'confermata',
];

const STATI_CORSA = [
  'prenotabile',
  'in_corso',
  'da_attivare',
];

function fail(message) {
  throw new Error(`POPBUS_VEHICLE_COMMITMENTS_SHADOW: ${message}`);
}

function timestamp(value, field) {
  if (value === null || value === undefined) {
    fail(`${field} mancante`);
  }

  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value);

  if (!Number.isFinite(ms)) {
    fail(`${field} non valido`);
  }

  return ms;
}

function normalizeVehicleId(value) {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    fail(`veicolo_id non valido: ${String(value)}`);
  }

  return id;
}

function normalizeInterval(start, end) {
  const a = timestamp(start, 'busyStart');
  const b = timestamp(end, 'busyEnd');

  if (b <= a) {
    fail('intervallo operativo non valido');
  }

  return { start: a, end: b };
}

function overlaps(commitment, start, end) {
  return commitment.start < end && commitment.end > start;
}

/**
 * Carica gli impegni dei veicoli.
 *
 * Il chiamante deve fornire un client PostgreSQL
 * già inserito nella transazione di snapshot.
 *
 * Gli intervalli vengono calcolati da PostgreSQL,
 * utilizzando le stesse conversioni della query SHADOW.
 */
export async function caricaImpegniVeicoliShadow(
  client,
  vehicleIds,
) {
  if (!client || typeof client.query !== 'function') {
    fail('client PostgreSQL mancante');
  }

  if (!Array.isArray(vehicleIds)) {
    fail('vehicleIds deve essere un array');
  }

  const ids = [...new Set(
    vehicleIds.map(normalizeVehicleId),
  )].sort((a, b) => a - b);

  const byVehicle = new Map(
    ids.map(id => [id, []]),
  );

  if (ids.length === 0) {
    return {
      byVehicle,
      diagnostica: {
        veicoli: 0,
        attivazioni: 0,
        corse: 0,
        impegni: 0,
        queryDb: 0,
      },
    };
  }

  const { rows } = await client.query(`
    SELECT
      a.veicolo_id,
      'attivazione' AS origine,
      a.id::text AS riferimento,
      COALESCE(
        (a.piano->>'busyStart')::timestamptz,
        a.partenza
      ) AS inizio,
      COALESCE(
        (a.piano->>'busyEnd')::timestamptz,
        a.arrivo
      ) AS fine
    FROM popbus_attivazioni a
    WHERE a.veicolo_id = ANY($1::integer[])
      AND a.stato = ANY($2::text[])

    UNION ALL

    SELECT
      c.veicolo_id,
      'corsa' AS origine,
      c.id::text AS riferimento,
      c.start_datetime AS inizio,
      c.arrivo_datetime AS fine
    FROM corse c
    WHERE c.veicolo_id = ANY($1::integer[])
      AND c.stato = ANY($3::text[])
  `, [
    ids,
    STATI_ATTIVAZIONE,
    STATI_CORSA,
  ]);

  let attivazioni = 0;
  let corse = 0;

  for (const row of rows) {
    const vehicleId = normalizeVehicleId(row.veicolo_id);

    if (!byVehicle.has(vehicleId)) {
      fail(`veicolo inatteso nella query: ${vehicleId}`);
    }

    const start = timestamp(row.inizio, 'inizio impegno');

    // La query originale tratta arrivo_datetime NULL
    // come intervallo senza limite superiore.
    const end = row.fine === null
      ? Infinity
      : timestamp(row.fine, 'fine impegno');

    // Non scartare gli intervalli anomali presenti nel DB:
    // la query SQL originale valuta comunque la sovrapposizione.
    // Il controllo fail-closed resta sugli intervalli operativi richiesti.

    if (row.origine === 'attivazione') {
      attivazioni++;
    } else if (row.origine === 'corsa') {
      corse++;
    } else {
      fail(`origine impegno sconosciuta: ${row.origine}`);
    }

    byVehicle.get(vehicleId).push({
      origine: row.origine,
      riferimento: String(row.riferimento),
      start,
      end,
    });
  }

  for (const commitments of byVehicle.values()) {
    commitments.sort((a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      a.riferimento.localeCompare(b.riferimento)
    );
  }

  return {
    byVehicle,
    diagnostica: {
      veicoli: ids.length,
      attivazioni,
      corse,
      impegni: rows.length,
      queryDb: 1,
    },
  };
}

/**
 * Verifica se il veicolo ha impegni sovrapposti.
 *
 * Intervalli adiacenti non sono considerati
 * sovrapposti, coerentemente con la SQL originale.
 */
export function verificaConflittoInMemoria(
  indice,
  vehicleId,
  busyStart,
  busyEnd,
) {
  if (!(indice?.byVehicle instanceof Map)) {
    fail('indice impegni non valido');
  }

  const id = normalizeVehicleId(vehicleId);
  const interval = normalizeInterval(busyStart, busyEnd);

  if (!indice.byVehicle.has(id)) {
    // Non possiamo dichiarare libero un veicolo
    // che non è stato incluso nello snapshot.
    fail(`veicolo ${id} non presente nell'indice`);
  }

  const commitments = indice.byVehicle.get(id);

  for (const commitment of commitments) {
    if (commitment.start >= interval.end) {
      break;
    }

    if (overlaps(commitment, interval.start, interval.end)) {
      return true;
    }
  }

  return false;
}