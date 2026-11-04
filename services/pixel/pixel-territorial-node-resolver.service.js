// services/pixel/pixel-territorial-node-resolver.service.js
// Resolver dei nodi territoriali PIXEL.
// Identita': localita' + codice ISTAT del comune.
// Non modifica worker, direttrici, fermate o richieste POPBUS.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from '../../db/db.js';
import { getLocalitaDetails, searchGooglePlaces } from '../../utils/maps.util.js';

const DATASET_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/ISTAT/ASL_comuni_popolazione_2024.csv'
);

let comuniIndexPromise = null;

function assert(condition, message) {
  if (!condition) throw new TypeError(`PIXEL_TERRITORIAL_NODE: ${message}`);
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseSemicolonCsvLine(line) {
  // Il dataset ISTAT in uso non contiene separatori ';' nei campi.
  return line.split(';').map(value => value.trim());
}

async function loadComuniIndex() {
  if (!comuniIndexPromise) {
    comuniIndexPromise = (async () => {
      const raw = await readFile(DATASET_PATH, 'utf8');
      const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);

      assert(lines.length >= 2, 'dataset ISTAT vuoto o incompleto');

      const headers = parseSemicolonCsvLine(lines[0]);
      const index = name => headers.indexOf(name);

      const codiceIndex = index('CODICE COMUNE');
      const comuneIndex = index('COMUNE');
      const regioneIndex = index('DENOMINAZIONE REGIONE');

      assert(codiceIndex >= 0 && comuneIndex >= 0 && regioneIndex >= 0,
        'colonne necessarie assenti nel dataset ISTAT');

      const byComuneRegione = new Map();

      for (const line of lines.slice(1)) {
        const fields = parseSemicolonCsvLine(line);
        const codice = fields[codiceIndex];
        const comune = fields[comuneIndex];
        const regione = fields[regioneIndex];

        if (!/^\d{6}$/.test(codice) || !comune || !regione) continue;

        const key = `${normalizeText(comune)}|${normalizeText(regione)}`;
        const entries = byComuneRegione.get(key) ?? [];
        entries.push({ codice, comune, regione });
        byComuneRegione.set(key, entries);
      }

      return byComuneRegione;
    })().catch(error => {
      comuniIndexPromise = null;
      throw error;
    });
  }

  return comuniIndexPromise;
}

async function resolveIstatCode(details) {
  const comuni = await loadComuniIndex();
  const comune = normalizeText(details.comune);
  const regione = normalizeText(details.regione);

  let matches = regione
    ? comuni.get(`${comune}|${regione}`) ?? []
    : [];

  // Fallback ammesso solo se il nome del comune identifica un solo codice
  // nell'intero dataset: in caso contrario non si indovina.
  if (matches.length === 0) {
    matches = [];
    for (const entries of comuni.values()) {
      for (const entry of entries) {
        if (normalizeText(entry.comune) === comune) matches.push(entry);
      }
    }
  }

  const uniqueCodes = [...new Set(matches.map(item => item.codice))];
  assert(uniqueCodes.length === 1,
    uniqueCodes.length === 0
      ? `comune ISTAT non trovato: ${details.comune} (${details.regione ?? 'regione assente'})`
      : `comune ISTAT ambiguo: ${details.comune}`);

  return uniqueCodes[0];
}

function validateCoordinates(coord) {
  const lat = Number(coord?.lat);
  const lon = Number(coord?.lon ?? coord?.lng);

  assert(Number.isFinite(lat) && lat >= -90 && lat <= 90,
    'latitudine non valida');
  assert(Number.isFinite(lon) && lon >= -180 && lon <= 180,
    'longitudine non valida');
  assert(!(lat === 0 && lon === 0), 'coordinate nulle');

  return { lat, lon };
}

async function findExistingNode(database, codiceIstat, localita) {
  const { rows } = await database.query(`
    SELECT id, nome, codice_istat_comune,
           ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE codice_istat_comune = $1
      AND LOWER(BTRIM(SPLIT_PART(nome, ',', 1))) = LOWER($2)
    ORDER BY id
    LIMIT 1
  `, [codiceIstat, localita]);

  return rows[0] ?? null;
}

async function resolveRepresentativeCoordinates(details, inputCoord) {
  const query = [
    details.localita,
    details.comune,
    details.provincia,
    details.regione,
    'Italia'
  ].filter(Boolean).join(', ');

  const places = await searchGooglePlaces(query, inputCoord, {
    radiusMeters: 5000,
    timeoutMs: 12000
  });

  const target = normalizeText(details.localita);

  const candidates = places.filter(place =>
    normalizeText(place.displayName?.text) === target &&
    Array.isArray(place.types) &&
    place.types.includes('locality') &&
    Number.isFinite(Number(place.location?.latitude)) &&
    Number.isFinite(Number(place.location?.longitude))
  );

  assert(candidates.length > 0,
    `Google Places non ha restituito un centro abitato verificabile per ${details.localita}`);

  // Se Google restituisce più risultati con lo stesso nome, scegliamo quello
  // più vicino alle coordinate della richiesta, senza cambiare identita'.
  candidates.sort((a, b) => {
    const distanceSquared = place =>
      (Number(place.location.latitude) - inputCoord.lat) ** 2 +
      (Number(place.location.longitude) - inputCoord.lon) ** 2;

    return distanceSquared(a) - distanceSquared(b);
  });

  return {
    lat: Number(candidates[0].location.latitude),
    lon: Number(candidates[0].location.longitude),
    formatted_address: candidates[0].formattedAddress ?? null
  };
}

/**
 * Risolve o crea il nodo territoriale corrispondente alla localita' delle
 * coordinate ricevute.
 *
 * @param {{lat:number, lon?:number, lng?:number}} coord
 * @param {{database?:object}} options
 * @returns {Promise<object>} nodo persistente e dati territoriali risolti
 */
export async function resolveOrCreateTerritorialNode(coord, {
  database = pool
} = {}) {
  const inputCoord = validateCoordinates(coord);

  const details = await getLocalitaDetails(inputCoord);
  assert(details?.localita && details?.comune,
    'reverse geocoding non ha identificato localita e comune');

  const codiceIstat = await resolveIstatCode(details);
  const localita = String(details.localita).trim();

  // Percorso veloce: le localita' gia' censite non richiedono Places.
  const existing = await findExistingNode(database, codiceIstat, localita);
  if (existing) {
    return {
      creato: false,
      id: Number(existing.id),
      nome: existing.nome,
      codice_istat_comune: existing.codice_istat_comune,
      localita,
      comune: details.comune,
      provincia: details.provincia ?? null,
      regione: details.regione ?? null,
      lat: Number(existing.lat),
      lon: Number(existing.lon)
    };
  }

  // Le coordinate rappresentative vengono cercate solo se il nodo manca.
  const representative = await resolveRepresentativeCoordinates(details, inputCoord);
  const nome = [
    localita,
    details.provincia ?? details.comune,
    details.regione ?? 'Italia'
  ].join(', ');

  const client = await database.connect();
  let transaction = false;

  try {
    await client.query('BEGIN');
    transaction = true;

    // Lock deterministico sulla coppia codice ISTAT + localita'.
    const lockKey = `${codiceIstat}:${normalizeText(localita)}`;
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [lockKey]
    );

    // Ricontrollo obbligatorio dopo il lock: un'altra richiesta potrebbe
    // aver creato il nodo mentre veniva eseguito Google Places.
    const existingAfterLock = await findExistingNode(
      client, codiceIstat, localita
    );

    if (existingAfterLock) {
      await client.query('COMMIT');
      transaction = false;

      return {
        creato: false,
        id: Number(existingAfterLock.id),
        nome: existingAfterLock.nome,
        codice_istat_comune: existingAfterLock.codice_istat_comune,
        localita,
        comune: details.comune,
        provincia: details.provincia ?? null,
        regione: details.regione ?? null,
        lat: Number(existingAfterLock.lat),
        lon: Number(existingAfterLock.lon)
      };
    }

    const { rows } = await client.query(`
      INSERT INTO public.nodi_territoriali
        (nome, posizione, codice_istat_comune, attivo)
      VALUES (
        $1,
        ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
        $4,
        TRUE
      )
      RETURNING id, nome, codice_istat_comune,
                ST_Y(posizione::geometry) AS lat,
                ST_X(posizione::geometry) AS lon
    `, [nome, representative.lon, representative.lat, codiceIstat]);

    assert(rows.length === 1, 'inserimento nodo senza risultato');

    await client.query('COMMIT');
    transaction = false;

    const created = rows[0];

    return {
      creato: true,
      id: Number(created.id),
      nome: created.nome,
      codice_istat_comune: created.codice_istat_comune,
      localita,
      comune: details.comune,
      provincia: details.provincia ?? null,
      regione: details.regione ?? null,
      lat: Number(created.lat),
      lon: Number(created.lon),
      formatted_address: representative.formatted_address
    };
  } catch (error) {
    if (transaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[PIXEL TERRITORIAL NODE] Rollback fallito:', rollbackError.message);
      }
    }

    // L'indice univoco resta l'ultima protezione contro duplicati.
    if (error.code === '23505') {
      const existingAfterConflict = await findExistingNode(
        database, codiceIstat, localita
      );

      if (existingAfterConflict) {
        return {
          creato: false,
          id: Number(existingAfterConflict.id),
          nome: existingAfterConflict.nome,
          codice_istat_comune: existingAfterConflict.codice_istat_comune,
          localita,
          comune: details.comune,
          provincia: details.provincia ?? null,
          regione: details.regione ?? null,
          lat: Number(existingAfterConflict.lat),
          lon: Number(existingAfterConflict.lon)
        };
      }
    }

    throw error;
  } finally {
    client.release();
  }
}
