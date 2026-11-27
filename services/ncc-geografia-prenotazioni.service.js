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
       AND ${ruolo}_stato_geo <> 'VALIDATO_MANUALE'
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

  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 10 ||
    !ids.every(id =>
      typeof id === 'string' &&
      /^[1-9]\d{0,18}$/.test(id) &&
      BigInt(id) <= 9223372036854775807n
    ) ||
    new Set(ids).size !== ids.length
  ) {
    throw errore(
      400,
      'Selezionare da 1 a 10 prenotazioni valide.'
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
          { guard }
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

        elaborazione: for (const row of rows) {
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
                richiedeRiconferma: !utilizzabile,
                motivo: utilizzabile
                  ? null
                  : 'VALIDAZIONE_MANUALE_DA_RICONFERMARE'
              });

              continue;
            }

            if (validaPersistita(row, ruolo)) {
              risultati.push({
                id: String(row.id),
                ruolo,
                stato: row[ruolo + '_stato_geo'],
                riutilizzato: true
              });

              continue;
            }

            const indirizzo = row[ruolo];

            const chiave = JSON.stringify([
              indirizzo.trim(),
              ruolo
            ]);

            guard.verifica();

            if (!cache.has(chiave)) {
              const candidati = row[ruolo + "_candidati_riuso"];
              const candidato = candidati?.length === 1 ? candidati[0] : null;
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
    }
  );

  if (!sessione.consentito) {
    throw errore(
      429,
      'Validazione temporaneamente non disponibile. Riprovare.'
    );
  }

  return sessione.risultato;
}
