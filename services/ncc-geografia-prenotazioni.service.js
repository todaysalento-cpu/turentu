import { riconosciLuogoNcc } from './ncc-catalogo-luoghi.service.js';
import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';
import { normalizzaLocalita } from './ncc-locality-resolver.service.js';
import { confrontaStradeNcc } from './ncc-confronto-strade.service.js';
import {
  verificaComuneNcc,
  verificaTerritorioManualeNcc
} from './ncc-validazione-territoriale.service.js';
import {
  calcolaRiepilogoGeograficoNcc
} from './ncc-geografia-stato.service.js';

// NCC_RIEPILOGO_V2902C3C


import {
  creaValidazioneGeograficaNcc
} from './ncc-validazione-geografica.service.js';

import {
  creaGeografiaGuardNcc
} from './ncc-geografia-guard.service.js';

import {
  creaSessionManagerNcc
} from './ncc-planner-session.service.js';

// NCC_GEOGRAFIA_PRENOTAZIONI_V2902A
// NCC_GEOGRAFIA_SICUREZZA_V2902C
// NCC_GEOGRAFIA_RIPRESA_V2902C3A

const manager = creaSessionManagerNcc();

const TABELLA = 'public.ncc_prenotazioni_esterne';

const RUOLI = ['origine', 'destinazione'];

const FINESTRA_OPERATIVA_MS = 90000;

const STATI_VALIDI = new Set([
  'VALIDATO_AUTO',
  'VALIDATO_MANUALE',
  'VALIDATO_CATALOGO'
]);

const STATI = new Set([
  'DA_ELABORARE',
  'VALIDATO_AUTO',
  'VALIDATO_MANUALE',
  'VALIDATO_CATALOGO',
  'DA_VERIFICARE',
  'AMBIGUO',
  'FUORI_COMUNE',
  'NON_TROVATO',
  'ERRORE_API'
]);

function errore(status, message) {
  return Object.assign(new Error(message), { status });
}

function coordinateValide(lat, lon) {
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    (lat !== 0 || lon !== 0);
}

function validaPersistita(row, ruolo) {
  if (!STATI_VALIDI.has(row[ruolo + '_stato_geo'])) {
    return false;
  }

  // Il catalogo deve essere ricontrollato:
  // un punto operativo puo essere disattivato.
  if (row[ruolo + '_stato_geo'] === 'VALIDATO_CATALOGO') {
    return false;
  }

  const scadenza = row[ruolo + '_geo_scade_il'];

  return coordinateValide(
    row[ruolo + '_lat'],
    row[ruolo + '_lon']
  ) &&
    Boolean(row[ruolo + '_verificata_il']) &&
    Boolean(scadenza) &&
    Date.parse(scadenza) > Date.now();
}


function selezioneRiusoAutomatico(ruolo) {
  return `ARRAY(
    SELECT to_jsonb(candidato)
    FROM (
      SELECT DISTINCT ON (q.${ruolo}_lat, q.${ruolo}_lon)
        q.${ruolo}_lat AS lat,
        q.${ruolo}_lon AS lon,
        q.${ruolo}_normalizzata AS normalizzata,
        q.${ruolo}_place_id AS place_id,
        q.${ruolo}_geo_scade_il AS geo_scade_il,
        q.${ruolo}_fonte_geo AS fonte_geo
      FROM ${TABELLA} q
      WHERE q.operatore_id = p.operatore_id
        AND q.id <> p.id
        AND q.annullata_il IS NULL
        AND lower(btrim(q.${ruolo})) = lower(btrim(p.${ruolo}))
        AND q.${ruolo}_stato_geo = 'VALIDATO_AUTO'
        AND q.${ruolo}_fonte_geo IS DISTINCT FROM 'OPENSTREETMAP_TERMINAL'
        AND q.${ruolo}_verificata_il IS NOT NULL
        AND q.${ruolo}_geo_scade_il > now()
        AND q.${ruolo}_lat IS NOT NULL
        AND q.${ruolo}_lon IS NOT NULL
      ORDER BY q.${ruolo}_lat, q.${ruolo}_lon, q.${ruolo}_verificata_il DESC, q.id
      LIMIT 2
    ) candidato
  ) AS ${ruolo}_candidati_riuso`;
}

function normalizzaEsito(r) {
  let stato = STATI.has(r?.stato)
    ? r.stato
    : 'ERRORE_API';

  const p = r?.punto ?? {};

  const lat = r?.lat ?? p.lat;
  const lon = r?.lon ?? p.lon;

  const valido =
    r?.valido === true &&
    STATI_VALIDI.has(stato) &&
    coordinateValide(lat, lon);

  if (STATI_VALIDI.has(stato) && !valido) {
    stato = 'DA_VERIFICARE';
  }

  const fonte = r?.fonte ?? p.fonte ?? null;

  // Scadenza prudenziale iniziale.
  const scadenza = valido
    ? (
        stato === 'VALIDATO_CATALOGO'
          ? r.geoScadeIl ?? null
          : r?.riutilizzato === true ? r.geoScadeIl : new Date(
              Date.now() + 24 * 60 * 60 * 1000
            ).toISOString()
      )
    : null;

  return {
    stato,
    valido,
    normalizzato:
      p.indirizzo ??
      r?.normalizzato ??
      r?.originale ??
      null,

    lat: valido ? lat : null,
    lon: valido ? lon : null,

    placeId: valido
      ? r?.placeId ?? p.placeId ?? null
      : null,

    fonte,

    puntoOperativoId:
      valido && stato === 'VALIDATO_CATALOGO'
        ? r.puntoOperativoId ?? null
        : null,

    scadenza,

    dettaglio: {
      motivo: r?.motivo ?? null,
      comuneAtteso: r?.comuneAtteso ?? null,
      richiedeVerifica: !valido
    }
  };
}

// NCC_GEO_TRANSAZIONE_SICURA_V2902E1
async function salvaEsito(
  pool,
  operatore,
  row,
  ruolo,
  esito,
  guard
) {
  if (!RUOLI.includes(ruolo)) {
    throw errore(400, 'Ruolo non valido');
  }

  guard.verifica();

  const client = await pool.connect();

  let erroreRollback = null;
  let transazioneAperta = false;

  try {
    guard.verifica();

    await client.query('BEGIN');

    transazioneAperta = true;

    guard.verifica();

    await client.query(
      "SET LOCAL lock_timeout = '2000ms'"
    );

    await client.query(
      "SET LOCAL statement_timeout = '5000ms'"
    );

    guard.verifica();

    await client.query(
      'SELECT pg_advisory_xact_lock(22022, $1::integer)',
      [operatore]
    );

    guard.verifica();

    const { rowCount } = await client.query(
    `UPDATE ${TABELLA}
     SET
       ${ruolo}_normalizzata = $4,
       ${ruolo}_lat = $5,
       ${ruolo}_lon = $6,
       ${ruolo}_place_id = $7,
       ${ruolo}_stato_geo = $8,
       ${ruolo}_fonte_geo = $9,
       ${ruolo}_dettaglio_geo = $10::jsonb,
       ${ruolo}_geo_scade_il = $11,
       ${ruolo}_punto_operativo_id = $12,
       ${ruolo}_verificata_il =
         CASE WHEN $13::boolean
           THEN now()
           ELSE NULL
         END
     WHERE operatore_id = $1
       AND id = $2
       AND ${ruolo} = $3
       AND annullata_il IS NULL
       AND ($8 = 'VALIDATO_MANUALE' OR ${ruolo}_stato_geo <> 'VALIDATO_MANUALE')
       AND ($8 <> 'VALIDATO_MANUALE' OR ${ruolo}_stato_geo <> 'VALIDATO_CATALOGO')
       AND NOT EXISTS (
         SELECT 1
         FROM public.ncc_gruppi_approvati g
         WHERE g.operatore_id = $1
           AND $2::bigint = ANY(g.prenotazioni)
       )
       AND aggiornata_il IS NOT DISTINCT FROM $14::timestamptz
       AND ${ruolo}_stato_geo = $15
       AND ${ruolo}_verificata_il
           IS NOT DISTINCT FROM $16::timestamptz`,
    [
      operatore,
      row.id,
      row[ruolo],
      esito.normalizzato,
      esito.lat,
      esito.lon,
      esito.placeId,
      esito.stato,
      esito.fonte,
      JSON.stringify(esito.dettaglio),
      esito.scadenza,
      esito.puntoOperativoId,
      esito.valido,
      row.revisione_geo,
      row[ruolo + '_stato_geo'],
      row[ruolo + '_revisione_geo']
    ]
  );

    guard.verifica();

    await client.query('COMMIT');

    transazioneAperta = false;

    return rowCount === 1;

  } catch (error) {
    if (transazioneAperta) {
      try {
        await client.query('ROLLBACK');

        transazioneAperta = false;

      } catch {
        erroreRollback = error;
        throw error;
      }
    }

    throw error;

  } finally {
    // Il rilascio avviene una sola volta.
    client.release(erroreRollback ?? undefined);
  }
}

async function leggiPuntoGoogleNcc(placeId, guard) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw errore(503, 'Google Maps non disponibile.');
  if (!(await guard.autorizza('PLACES'))) throw errore(429, 'Budget Google Places esaurito.');
  const response = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) + '?languageCode=it', {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'id,location,addressComponents,displayName,types' },
    signal: AbortSignal.any([guard.signal, AbortSignal.timeout(6000)])
  });
  if (!response.ok) throw errore(response.status === 404 ? 400 : 503, 'Impossibile leggere il punto Google selezionato.');
  return response.json();
}

export async function confermaPuntoGoogleNcc(pool, operatore, id, body = {}, dipendenze = {}) {
  const { ruolo, placeId, indirizzo, accettaPosizioneIndicativa } = body;
  if (!RUOLI.includes(ruolo) || typeof placeId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(placeId) ||
    placeId.startsWith('turentu_') || typeof indirizzo !== 'string' || !indirizzo.trim() || indirizzo.length > 250) {
    throw errore(400, 'Seleziona un indirizzo Google valido.');
  }
  const sessione = await (dipendenze.manager ?? manager).esegui(operatore, async sessione => {
    const guard = creaGeografiaGuardNcc({
          limits: process.env.NCC_GEO_TEST_BYPASS_ENABLED === 'true' && String(operatore) === '2' ? { maxGeocoding: 3000, maxPlaces: 600 } : undefined, signal: sessione.signal, verificaAttiva: sessione.verificaAttiva,
      autorizzaDistribuita: sessione.autorizzaGeografia, autorizzazioneRigorosa: true });
    try {
      const { rows } = await pool.query(
        'SELECT p.*, p.aggiornata_il::text AS revisione_geo, p.origine_verificata_il::text AS origine_revisione_geo, p.destinazione_verificata_il::text AS destinazione_revisione_geo ' +
        'FROM public.ncc_prenotazioni_esterne p WHERE p.operatore_id = $1 AND p.id = $2::bigint AND p.annullata_il IS NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM public.ncc_gruppi_approvati g WHERE g.operatore_id = p.operatore_id AND p.id = ANY(g.prenotazioni))',
        [operatore, id]
      );
      const row = rows[0];
      if (!row) throw errore(404, 'Prenotazione attiva e modificabile non trovata.');
      if (row[ruolo] !== indirizzo) throw errore(409, 'L’indirizzo è cambiato. Riapri la prenotazione.');
      if (row[ruolo + '_stato_geo'] === 'VALIDATO_CATALOGO' || row[ruolo + '_fonte_geo'] === 'OPENSTREETMAP_TERMINAL') {
        throw errore(400, 'Questo riferimento aeroportuale o di catalogo segue la sua verifica dedicata.');
      }
      const luogo = await guard.attendi(() => (dipendenze.leggiPunto ?? leggiPuntoGoogleNcc)(placeId, guard));
      const lat = luogo?.location?.latitude;
      const lon = luogo?.location?.longitude;
      const componente = tipo => luogo?.addressComponents?.find(part => part.types?.includes(tipo));
      if (typeof luogo?.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(luogo.id) || !coordinateValide(lat, lon) || componente('country')?.shortText !== 'IT' ||
        luogo.types?.includes('airport')) {
        throw errore(400, 'La selezione Google non identifica un punto utilizzabile.');
      }
      const analisi = analizzaIndirizzoNcc(indirizzo);
      const comuneGoogle = componente('administrative_area_level_3')?.longText ?? componente('locality')?.longText;
      const comuneAtteso = (analisi.comune ?? comuneGoogle ?? '').replace(/\s+[A-Z]{2}$/, '');
      const nomeGoogle = normalizzaLocalita(luogo.displayName?.text);
      const nomeRichiesto = normalizzaLocalita(indirizzo.split(',')[0]);
      // NCC_PRECISIONE_STRADA_V2
      const poiIdentificato = Boolean(
        nomeGoogle &&
        nomeGoogle === nomeRichiesto &&
        !luogo.types?.includes('route') &&
        luogo.types?.some(tipo =>
          [
            'establishment',
            'point_of_interest',
            'lodging',
            'plaza',
            'town_square',
            'park'
          ].includes(tipo)
        )
      );
      // NCC_PRECISIONE_STRADA_V1
      const stradaRichiesta = analisi.civico
        ? analisi.indirizzo.slice(0, -analisi.civico.length).trim().replace(/,$/, '')
        : analisi.indirizzo;
      const stradaGoogle = componente('route')?.longText;
      const strada = confrontaStradeNcc(stradaRichiesta, stradaGoogle);
      const civicoCoerente = analisi.civico &&
        normalizzaLocalita(analisi.civico) === normalizzaLocalita(componente('street_number')?.longText);
      const viaCoerente = Boolean(stradaGoogle && (
        normalizzaLocalita(stradaRichiesta) === normalizzaLocalita(stradaGoogle) ||
        ['NOME_NORMALIZZATO', 'SPAZI_EQUIVALENTI', 'INIZIALI_COMPATIBILI'].includes(strada.motivo)
      ));

      const civicoGoogle = componente('street_number')?.longText;

      const comuneEsplicito = Boolean(
        analisi.comune &&
        comuneGoogle &&
        normalizzaLocalita(comuneAtteso) ===
        normalizzaLocalita(comuneGoogle)
      );

      const riferimentoStradale =
        /^(via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\s/i
          .test(analisi.indirizzo);

      // NCC_PRECISIONE_HARDENING_V4
      const viaCoerenteIndicativa = Boolean(
        viaCoerente &&
        strada.compatibile === true &&
        [
          'NOME_NORMALIZZATO',
          'SPAZI_EQUIVALENTI'
        ].includes(strada.motivo)
      );

      const posizioneIndicativa = Boolean(
        riferimentoStradale &&
        comuneEsplicito &&
        viaCoerenteIndicativa &&
        !civicoGoogle &&
        luogo.types?.includes('route') &&
        !analisi.ambiguo &&
        !analisi.puntoInteresse &&
        !poiIdentificato
      );

      const motivoPrecisione = posizioneIndicativa
        ? (
            analisi.civico
              ? 'CIVICO_NON_RICONOSCIUTO'
              : 'CIVICO_MANCANTE'
          )
        : null;

      if (
        !comuneAtteso ||
        (
          !poiIdentificato &&
          !(civicoCoerente && viaCoerente) &&
          !posizioneIndicativa
        )
      ) {
        throw errore(
          400,
          'Il punto scelto non conferma il nome della struttura oppure via, civico e comune.'
        );
      }

      // NCC_PRECISIONE_TERRITORIO_V3
      const territorio = await guard.attendi(() =>
        (dipendenze.verificaComune ?? verificaComuneNcc)(pool, { lat, lon, comuneAtteso }));
      if (!territorio.valido) throw errore(400, 'Il punto scelto è fuori dal comune richiesto o non verificabile.');

      if (
        posizioneIndicativa &&
        accettaPosizioneIndicativa !== true
      ) {
        throw errore(
          400,
          motivoPrecisione === 'CIVICO_MANCANTE'
            ? 'NCC_CIVICO_MANCANTE: Via e comune riconosciuti. Confermare la posizione indicativa.'
            : 'NCC_CIVICO_NON_RICONOSCIUTO: Numero civico non verificato. Confermare la posizione indicativa.'
        );
      }
      const esito = normalizzaEsito({ stato: 'VALIDATO_MANUALE', valido: true, lat, lon, placeId: luogo.id,
        fonte: 'GOOGLE_PLACES_CONFERMATO', normalizzato: analisi.normalizzato, comuneAtteso, motivo: posizioneIndicativa
          ? motivoPrecisione
          : 'PUNTO_SCELTO_OPERATORE' });

      esito.dettaglio = {
        ...esito.dettaglio,
        precisione: posizioneIndicativa
          ? 'STRADA'
          : poiIdentificato
            ? 'POI'
            : 'CIVICO',
        posizioneIndicativa,
        numeroCivicoMancante:
          posizioneIndicativa && !analisi.civico,
        numeroCivicoNonRiconosciuto:
          posizioneIndicativa && Boolean(analisi.civico),
        civicoVerificatoDaGoogle:
          Boolean(civicoCoerente && viaCoerente),
        confermatoDaOperatore: true,
        operatoreId: String(operatore)
      };
      if (!(await salvaEsito(pool, operatore, row, ruolo, esito, guard))) {
        throw errore(409, 'La prenotazione è cambiata. Riaprila e riprova.');
      }
      return {
        id: String(id),
        ruolo,
        stato: esito.stato,
        normalizzato: esito.normalizzato,
        precisione: esito.dettaglio.precisione,
        posizioneIndicativa,
        avviso: motivoPrecisione,
        dettaglio: esito.dettaglio
      };
    } finally {
      guard.interrompi('NCC_CONFERMA_PUNTO_TERMINATA');
    }
  }, { applicaCooldown: false });
  if (!sessione.consentito) throw errore(429, 'Un’altra verifica è in corso. Riprova al termine.');
  return sessione.risultato;
}


// NCC_CONFERMA_MAPPA_V1
export async function confermaPuntoManualeNcc(
  pool,
  operatore,
  id,
  body = {},
  dipendenze = {}
) {
  const {
    ruolo,
    indirizzo,
    lat,
    lon,
    confermato
  } = body;

  if (
    !RUOLI.includes(ruolo) ||
    typeof indirizzo !== 'string' ||
    !indirizzo.trim() ||
    indirizzo.length > 250 ||
    !coordinateValide(lat, lon) ||
    confermato !== true
  ) {
    throw errore(
      400,
      'Indirizzo, coordinate e conferma esplicita obbligatori.'
    );
  }

  const analisi = analizzaIndirizzoNcc(indirizzo);

  const comuneAtteso = String(
    analisi.comune ?? ''
  ).replace(/\s+[A-Z]{2}$/, '').trim();

  if (!comuneAtteso) {
    throw errore(
      400,
      'Specificare il comune nell’indirizzo prima della conferma.'
    );
  }

  if (/\b(aeroporto|airport|aerostazione)\b/i.test(indirizzo)) {
    throw errore(
      400,
      'Utilizzare la verifica dedicata ai riferimenti aeroportuali.'
    );
  }

  const sessione = await (
    dipendenze.manager ?? manager
  ).esegui(
    operatore,
    async sessione => {

      const guard = creaGeografiaGuardNcc({
        signal: sessione.signal,
        verificaAttiva: sessione.verificaAttiva,
        autorizzaDistribuita: sessione.autorizzaGeografia,
        autorizzazioneRigorosa: true
      });

      try {
        guard.verifica();

        const { rows } = await guard.attendi(() =>
          pool.query(
            'SELECT p.*, ' +
            'p.aggiornata_il::text AS revisione_geo, ' +
            'p.origine_verificata_il::text AS origine_revisione_geo, ' +
            'p.destinazione_verificata_il::text AS destinazione_revisione_geo ' +
            'FROM public.ncc_prenotazioni_esterne p ' +
            'WHERE p.operatore_id = $1 ' +
            'AND p.id = $2::bigint ' +
            'AND p.annullata_il IS NULL ' +
            'AND NOT EXISTS (' +
            'SELECT 1 FROM public.ncc_gruppi_approvati g ' +
            'WHERE g.operatore_id = p.operatore_id ' +
            'AND p.id = ANY(g.prenotazioni))',
            [operatore, id]
          )
        );

        const row = rows[0];

        if (!row) {
          throw errore(
            404,
            'Prenotazione attiva e modificabile non trovata.'
          );
        }

        if (row[ruolo] !== indirizzo) {
          throw errore(
            409,
            'L’indirizzo è cambiato. Riapri la prenotazione.'
          );
        }

        if (
          row[ruolo + '_stato_geo'] === 'VALIDATO_CATALOGO' ||
          row[ruolo + '_fonte_geo'] === 'OPENSTREETMAP_TERMINAL' ||
          row[ruolo + '_punto_operativo_id'] != null
        ) {
          throw errore(
            400,
            'Questo riferimento segue la verifica dedicata.'
          );
        }


        // NCC_MAPPA_PROTEZIONE_CATALOGO
        const catalogo = await guard.attendi(() =>
          (dipendenze.riconosciLuogo ?? riconosciLuogoNcc)(
            pool,
            indirizzo
          )
        );

        if (
          catalogo?.stato !== 'NON_TROVATO' ||
          analisi.codiceAeroporto
        ) {
          throw errore(
            400,
            'Utilizzare la verifica dedicata ai riferimenti di catalogo o aeroportuali.'
          );
        }

        // NCC_TERRITORIO_MANUALE_V1_6
        const territorio = await guard.attendi(() =>
          (
            dipendenze.verificaTerritorioManuale ??
            verificaTerritorioManualeNcc
          )(
            pool,
            { indirizzo, lat, lon }
          )
        );

        if (!territorio.valido) {
          throw errore(
            400,
            territorio.stato === 'FUORI_LOCALITA'
              ? 'Il punto scelto è fuori dalla località richiesta.'
              : 'Il punto scelto è fuori dal territorio richiesto o non verificabile.'
          );
        }

        const esito = normalizzaEsito({
          stato: 'VALIDATO_MANUALE',
          valido: true,
          lat,
          lon,
          placeId: null,
          fonte: 'OPERATORE_MAPPA',
          normalizzato: analisi.normalizzato,
          comuneAtteso,
          motivo: 'COORDINATE_CONFERMATE_OPERATORE'
        });

        esito.dettaglio = {
          ...esito.dettaglio,
          confermatoDaOperatore: true,
          operatoreId: String(operatore),
          precisione: 'POSIZIONE_MANUALE',
          civicoVerificatoDaGoogle: false,
          precisioneTerritoriale:
            territorio.precisioneTerritoriale,
          comuneAmministrativo:
            territorio.comuneAmministrativo,
          codiceIstatComune:
            territorio.codiceIstatComune,
          localita: territorio.localita,
          localitaGid: territorio.localitaGid
        };

        if (!(await salvaEsito(
          pool,
          operatore,
          row,
          ruolo,
          esito,
          guard
        ))) {
          throw errore(
            409,
            'La prenotazione è cambiata. Riaprila e riprova.'
          );
        }

        return {
          id: String(id),
          ruolo,
          stato: esito.stato,
          normalizzato: esito.normalizzato,
          fonte: esito.fonte,
          lat: esito.lat,
          lon: esito.lon
        };

      } finally {
        guard.interrompi(
          'NCC_CONFERMA_MAPPA_TERMINATA'
        );
      }
    },
    { applicaCooldown: false }
  );

  if (!sessione.consentito) {
    throw errore(
      429,
      'Un’altra verifica è in corso. Riprova al termine.'
    );
  }

  return sessione.risultato;
}

export async function riepilogoGeografiaNcc(
  pool,
  operatore
) {
  return calcolaRiepilogoGeograficoNcc(
    pool,
    operatore
  );
}

export async function validaGeografiaPrenotazioniNcc(
  pool,
  operatore,
  body = {},
  dipendenze = {}
) {
  const ids = body.ids;
  const massimo = dipendenze.massiva === true ? 100 : 10;

  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > massimo ||
    !ids.every(id =>
      typeof id === 'string' &&
      /^[1-9]\d{0,18}$/.test(id) &&
      BigInt(id) <= 9223372036854775807n
    ) ||
    new Set(ids).size !== ids.length
  ) {
    throw errore(
      400,
      `Selezionare da 1 a ${massimo} prenotazioni valide.`
    );
  }

  const sessione = await (
    dipendenze.manager ?? manager
  ).esegui(
    operatore,
    async sessione => {
      const guard = creaGeografiaGuardNcc({
          limits: process.env.NCC_GEO_TEST_BYPASS_ENABLED === 'true' && String(operatore) === '2' ? { maxGeocoding: 3000, maxPlaces: 600 } : undefined,
        signal: sessione.signal,
        verificaAttiva: sessione.verificaAttiva,
        autorizzaDistribuita:
          sessione.autorizzaGeografia,
        autorizzazioneRigorosa: true
      });

      try {
        const motore = (
          dipendenze.creaValidazione ??
          creaValidazioneGeograficaNcc
        )(
          pool,
          { guard, soloIndirizzo: true }
        );

        const { rows } = await pool.query(
          `SELECT p.*,
                  p.aggiornata_il::text AS revisione_geo,
                  p.origine_verificata_il::text
                    AS origine_revisione_geo,
                  p.destinazione_verificata_il::text
                    AS destinazione_revisione_geo,
                  ${RUOLI.map(selezioneRiusoAutomatico).join(", ")},
                  EXISTS (
                    SELECT 1
                    FROM public.ncc_gruppi_approvati g
                    WHERE g.operatore_id = p.operatore_id
                      AND p.id = ANY(g.prenotazioni)
                  ) AS gruppo_approvato
           FROM ${TABELLA} p
           WHERE operatore_id = $1
             AND id = ANY($2::bigint[])
             AND annullata_il IS NULL
           ORDER BY id`,
          [operatore, ids]
        );

        if (rows.length !== ids.length) {
          throw errore(
            404,
            'Una o piu prenotazioni non disponibili.'
          );
        }

        const cache = new Map();
        const risultati = [];
        const inizio = performance.now();

        let motivoInterruzione = null;

        try {

        elaborazione: for (const [index, row] of rows.entries()) {
          if (index > 0 && index % 10 === 0) {
            dipendenze.avanzamento?.(index, rows.length);
          }
          if (row.gruppo_approvato) {
            risultati.push({
              id: String(row.id),
              salvato: false,
              motivo: 'GRUPPO_GIA_APPROVATO'
            });

            continue;
          }

          for (const ruolo of RUOLI) {
            guard.verifica();

            if (
              performance.now() - inizio >=
              FINESTRA_OPERATIVA_MS
            ) {
              motivoInterruzione =
                'FINESTRA_OPERATIVA_TERMINATA';

              break elaborazione;
            }

            if (
              row[ruolo + '_stato_geo'] ===
              'VALIDATO_MANUALE'
            ) {
              const utilizzabile =
                validaPersistita(row, ruolo);

              risultati.push({
                id: String(row.id),
                ruolo,
                stato: 'VALIDATO_MANUALE',
                riutilizzato: utilizzabile,
                salvato: false,

                precisione:
                  row[ruolo + '_dettaglio_geo']
                    ?.precisione ?? null,

                posizioneIndicativa:
                  row[ruolo + '_dettaglio_geo']
                    ?.posizioneIndicativa === true,

                numeroCivicoMancante:
                  row[ruolo + '_dettaglio_geo']
                    ?.numeroCivicoMancante === true,

                numeroCivicoNonRiconosciuto:
                  row[ruolo + '_dettaglio_geo']
                    ?.numeroCivicoNonRiconosciuto === true,
                richiedeRiconferma: !utilizzabile,
                motivo: utilizzabile
                  ? null
                  : 'VALIDAZIONE_MANUALE_DA_RICONFERMARE'
              });

              continue;
            }

            const indirizzoOriginale = row[ruolo];
            const latoVoloBds = row.volo_aeroporto === 'BDS' &&
              (row.volo_direzione === 'arrivo' ? ruolo === 'origine' : row.volo_direzione === 'partenza' && ruolo === 'destinazione');
            const soloCitta = indirizzoOriginale.trim().toLowerCase() === 'brindisi';
            const indirizzo = latoVoloBds && soloCitta
              ? 'Aeroporto di Brindisi (BDS), Brindisi'
              : indirizzoOriginale;

            const terminaleSalvato = row[ruolo + '_fonte_geo'] === 'OPENSTREETMAP_TERMINAL';
            if (validaPersistita(row, ruolo) && (!soloCitta || latoVoloBds === terminaleSalvato)) {
              risultati.push({
                id: String(row.id),
                ruolo,
                stato: row[ruolo + '_stato_geo'],
                riutilizzato: true
              });

              continue;
            }

            if (row[ruolo + '_stato_geo'] === 'VALIDATO_CATALOGO') {
              risultati.push({ id: String(row.id), ruolo, stato: 'VALIDATO_CATALOGO', salvato: false });
              continue;
            }

            const chiave = JSON.stringify([
              indirizzo.trim(),
              ruolo
            ]);

            guard.verifica();

            if (!cache.has(chiave)) {
              const candidati = row[ruolo + "_candidati_riuso"];
              const candidato = indirizzo === indirizzoOriginale && candidati?.length === 1 ? candidati[0] : null;
              const riuso = candidato && coordinateValide(candidato.lat, candidato.lon) &&
                Date.parse(candidato.geo_scade_il) > Date.now() ? {
                  stato: "VALIDATO_AUTO", valido: true, riutilizzato: true,
                  lat: candidato.lat, lon: candidato.lon, fonte: candidato.fonte_geo,
                  normalizzato: candidato.normalizzata, placeId: candidato.place_id,
                  geoScadeIl: candidato.geo_scade_il
                } : null;
              const risultato = await guard.attendi(
                () => motore.validaPunto(
                  indirizzo,
                  ruolo,
                  null,
                  riuso
                )
              );

              guard.verifica();

              cache.set(chiave, risultato);
            }

            const r = cache.get(chiave);

            guard.verifica();

            const esito = normalizzaEsito(r);

            // Un budget esaurito non rappresenta
            // un indirizzo geograficamente errato.
            if (
              esito.stato === 'DA_ELABORARE' ||
              esito.stato === 'ERRORE_API'
            ) {
              risultati.push({
                id: String(row.id),
                ruolo,
                stato: esito.stato,
                motivo: r.motivo ?? null,
                salvato: false
              });

              continue;
            }

            const salvato = await salvaEsito(
              pool,
              operatore,
              row,
              ruolo,
              esito,
              guard
            );

            risultati.push({
              id: String(row.id),
              ruolo,
              stato: esito.stato,
              riutilizzato: salvato && r?.riutilizzato === true,
              salvato,
              motivo: salvato
                ? esito.dettaglio.motivo
                : 'PRENOTAZIONE_MODIFICATA'
            });

            guard.verifica();
          }
        }

        } catch (error) {
          // Solo il timeout geografico e' recuperabile.
          // La perdita della sessione resta un errore.

          if (
            error?.message !==
            'NCC_GEOGRAFIA_DEADLINE' ||
            sessione.signal?.aborted
          ) {
            throw error;
          }

          sessione.verificaAttiva();

          motivoInterruzione =
            'NCC_GEOGRAFIA_DEADLINE';
        }

        const completati = new Set();

        for (const r of risultati) {
          if (r.ruolo) {
            completati.add(
              r.id + ':' + r.ruolo
            );
          } else if (
            r.motivo === 'GRUPPO_GIA_APPROVATO'
          ) {
            for (const ruolo of RUOLI) {
              completati.add(r.id + ':' + ruolo);
            }
          }
        }

        const nonElaborati = [];

        for (const row of rows) {
          for (const ruolo of RUOLI) {
            if (
              !completati.has(
                String(row.id) + ':' + ruolo
              )
            ) {
              nonElaborati.push({
                id: String(row.id),
                ruolo
              });
            }
          }
        }

        const riprovabili = risultati.filter(r =>
          r.stato === 'DA_ELABORARE' ||
          r.stato === 'ERRORE_API' ||
          r.motivo === 'PRENOTAZIONE_MODIFICATA'
        );

        return {
          parziale:
            motivoInterruzione !== null ||
            nonElaborati.length > 0 ||
            riprovabili.length > 0,

          motivoInterruzione,
          nonElaborati,
          riprovabili,

          puntiTotali: rows.length * RUOLI.length,

          puntiEsaminati: completati.size,

          puntiSalvati: risultati.filter(
            r => r.salvato === true
          ).length,

          durataMs: Math.round(
            performance.now() - inizio
          ),

          prenotazioni: rows.length,
          indirizziDistinti: cache.size,
          risultati,
          diagnostica: motore.diagnostica()
        };

      } finally {
        guard.interrompi('NCC_VALIDAZIONE_TERMINATA');
      }
    },
    { applicaCooldown: false }
  );

  if (!sessione.consentito) {
    throw errore(
      429,
      sessione.motivo === 'OPERATORE_OCCUPATO'
        ? 'Un’altra verifica o simulazione è in corso per questo operatore.'
        : 'Validazione temporaneamente non disponibile. Riprovare.'
    );
  }

  return sessione.risultato;
}
