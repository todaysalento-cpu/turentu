
import {
  risolviCatalogoNcc
} from './ncc-catalogo-luoghi.service.js';

import {
  normalizzaRestrizioniNcc
} from './ncc-compatibilita-veicoli.service.js';

// NCC_GEO_VINCOLI_V2902E2D1

const RUOLI = ['origine', 'destinazione'];

export function coordinateValideNcc(lat, lon) {
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    (lat !== 0 || lon !== 0);
}

export async function statoPuntoGeograficoNcc(
  db,
  row,
  ruolo,
  opzioni = {}
) {
  if (!RUOLI.includes(ruolo)) {
    throw new Error('Ruolo non valido');
  }

  const leggi = campo => row[ruolo + '_' + campo];

  const stato = leggi('stato_geo');

  const adesso = opzioni.adesso ?? Date.now();

  const risultato = (effettivo, utilizzabile = false) => ({
    ruolo,
    statoMemorizzato: stato,
    statoEffettivo: effettivo,
    utilizzabile
  });

  // La coordinata pubblica del terminal identifica l'indirizzo, non un punto di incontro.
  if (stato === 'VALIDATO_AUTO' && leggi('fonte_geo') === 'OPENSTREETMAP_TERMINAL') {
    return risultato('DA_VERIFICARE');
  }

  if (stato === 'VALIDATO_CATALOGO') {
    const resolver =
      opzioni.risolviCatalogo ?? risolviCatalogoNcc;

    const r = await resolver(
      db,
      row[ruolo],
      ruolo,
      row.operatore_id
    );

    const punto = r?.punto;

    if (
      !r?.valido ||
      !punto ||
      leggi('punto_operativo_id') == null ||
      String(punto.id) !==
        String(leggi('punto_operativo_id')) ||
      !coordinateValideNcc(punto.lat, punto.lon)
    ) {
      return risultato(
        'CATALOGO_NON_DISPONIBILE'
      );
    }

    if (
      punto.geo_scade_il != null &&
      !(Date.parse(punto.geo_scade_il) > adesso)
    ) {
      return risultato(
        'CATALOGO_NON_DISPONIBILE'
      );
    }

    // Se il punto e' stato spostato, richiede
    // una nuova validazione della prenotazione.

    if (
      !leggi('verificata_il') ||
      leggi('lat') !== punto.lat ||
      leggi('lon') !== punto.lon
    ) {
      return risultato(
        'CATALOGO_DA_AGGIORNARE'
      );
    }

    return {
      ...risultato('VALIDO', true),

      puntoOperativoId: punto.id,

      tipiVeicoloAmmessi:
        normalizzaRestrizioniNcc(
          punto.tipi_veicolo_ammessi
        )
    };
  }

  if (
    stato === 'VALIDATO_AUTO' ||
    stato === 'VALIDATO_MANUALE'
  ) {
    const utilizzabile =
      coordinateValideNcc(
        leggi('lat'),
        leggi('lon')
      ) &&
      Boolean(leggi('verificata_il')) &&
      Date.parse(leggi('geo_scade_il')) > adesso;

    if (utilizzabile) {
      // NCC_GEO_ANTI_BYPASS_V2902E2D2B

      const resolver =
        opzioni.risolviCatalogo ?? risolviCatalogoNcc;

      const r = await resolver(
        db,
        row[ruolo],
        ruolo,
        row.operatore_id
      );

      if (r?.stato === 'NON_TROVATO') {
        return {
          ...risultato('VALIDO', true),
          tipiVeicoloAmmessi: null,
          puntoOperativoId: null
        };
      }

      const punto = r?.punto;

      if (
        r?.valido !== true ||
        !punto ||
        punto.id == null ||
        !coordinateValideNcc(
          punto.lat,
          punto.lon
        ) ||
        (
          punto.geo_scade_il != null &&
          !(Date.parse(punto.geo_scade_il) > adesso)
        )
      ) {
        return {
          ...risultato(
            stato === 'VALIDATO_MANUALE'
              ? 'MANUALE_DA_RICONFERMARE'
              : 'CATALOGO_NON_DISPONIBILE'
          ),
          bloccoCatalogo: true,
          motivoCatalogo:
            r?.stato ?? 'CATALOGO_NON_VALIDO'
        };
      }

      const coincidente =
        leggi('lat') === punto.lat &&
        leggi('lon') === punto.lon;

      if (!coincidente) {
        return {
          ...risultato(
            stato === 'VALIDATO_MANUALE'
              ? 'MANUALE_DA_RICONFERMARE'
              : 'CATALOGO_DA_AGGIORNARE'
          ),
          bloccoCatalogo: true,
          motivoCatalogo:
            'COORDINATE_CATALOGO_DIFFERENTI'
        };
      }

      return {
        ...risultato('VALIDO', true),

        puntoOperativoId: punto.id,

        tipiVeicoloAmmessi:
          normalizzaRestrizioniNcc(
            punto.tipi_veicolo_ammessi
          )
      };
    }

    return risultato(
      stato === 'VALIDATO_MANUALE'
        ? 'MANUALE_DA_RICONFERMARE'
        : 'SCADUTO'
    );
  }

  if (stato === 'DA_ELABORARE') {
    return risultato('DA_ELABORARE');
  }

  if (stato === 'ERRORE_API') {
    return risultato('ERRORE_TEMPORANEO');
  }

  return risultato('DA_VERIFICARE');
}

export function statoPrenotazioneGeograficaNcc(
  origine,
  destinazione,
  approvata = false
) {
  if (approvata) {
    return 'GIA_APPROVATA';
  }

  if (
    origine.utilizzabile &&
    destinazione.utilizzabile
  ) {
    return 'PRONTA';
  }

  const stati = [
    origine.statoEffettivo,
    destinazione.statoEffettivo
  ];

  const priorita = [
    'MANUALE_DA_RICONFERMARE',
    'CATALOGO_NON_DISPONIBILE',
    'CATALOGO_DA_AGGIORNARE',
    'DA_VERIFICARE',
    'SCADUTO',
    'ERRORE_TEMPORANEO',
    'DA_ELABORARE'
  ];

  const stato = priorita.find(
    x => stati.includes(x)
  );

  return stato === 'SCADUTO'
    ? 'SCADUTA'
    : stato ?? 'DA_VERIFICARE';
}

export async function calcolaRiepilogoGeograficoNcc(
  db,
  operatore
) {
  const { rows } = await db.query(`
    SELECT
      p.id,
      p.operatore_id,
      p.origine,
      p.destinazione,
      p.origine_stato_geo,
      p.destinazione_stato_geo,
      p.origine_lat,
      p.origine_lon,
      p.destinazione_lat,
      p.destinazione_lon,
      p.origine_verificata_il,
      p.destinazione_verificata_il,
      p.origine_geo_scade_il,
      p.destinazione_geo_scade_il,
      p.origine_punto_operativo_id,
      p.destinazione_punto_operativo_id,
      p.origine_fonte_geo,
      p.destinazione_fonte_geo,
      p.origine_dettaglio_geo,
      p.destinazione_dettaglio_geo,
      EXISTS (
        SELECT 1
        FROM public.ncc_gruppi_approvati g
        WHERE g.operatore_id = p.operatore_id
          AND p.id = ANY(g.prenotazioni)
      ) AS gruppo_approvato
    FROM public.ncc_prenotazioni_esterne p
    WHERE p.operatore_id = $1
      AND p.annullata_il IS NULL
    ORDER BY p.id
  `, [operatore]);

  const stati = new Map();
  const classificazioni = {};
  const statiPunti = {};
  const cacheCatalogo = new Map();

  const adesso = Date.now();

  // NCC_PRECISIONE_STRADA_V2
  let puntiValidi = 0;
  let puntiIndicativiAccettati = 0;
  let prenotazioniConPuntiIndicativi = 0;
  let puntiApprovati = 0;

  async function resolver(db, indirizzo, ruolo) {
    const chiave = JSON.stringify([
      indirizzo,
      ruolo
    ]);

    if (!cacheCatalogo.has(chiave)) {
      cacheCatalogo.set(
        chiave,
        risolviCatalogoNcc(
          db,
          indirizzo,
          ruolo,
          operatore
        )
      );
    }

    return cacheCatalogo.get(chiave);
  }

  for (const row of rows) {
    const chiave = JSON.stringify([
      row.origine_stato_geo,
      row.destinazione_stato_geo
    ]);

    if (!stati.has(chiave)) {
      stati.set(chiave, {
        origine_stato_geo:
          row.origine_stato_geo,

        destinazione_stato_geo:
          row.destinazione_stato_geo,

        prenotazioni: 0
      });
    }

    stati.get(chiave).prenotazioni++;

    if (row.gruppo_approvato) {
      classificazioni.GIA_APPROVATA =
        (classificazioni.GIA_APPROVATA ?? 0) + 1;

      puntiApprovati += 2;

      continue;
    }

    const origine = await statoPuntoGeograficoNcc(
      db,
      row,
      'origine',
      { adesso, risolviCatalogo: resolver }
    );

    const destinazione =
      await statoPuntoGeograficoNcc(
        db,
        row,
        'destinazione',
        { adesso, risolviCatalogo: resolver }
      );

    let contieneIndicativi = false;

    for (const punto of [origine, destinazione]) {
      const stato = punto.statoEffettivo;

      statiPunti[stato] =
        (statiPunti[stato] ?? 0) + 1;

      if (punto.utilizzabile) {
        puntiValidi++;

        const dettaglio =
          row[punto.ruolo + '_dettaglio_geo'] ?? {};

        if (
          dettaglio.precisione === 'STRADA' &&
          dettaglio.posizioneIndicativa === true
        ) {
          puntiIndicativiAccettati++;
          contieneIndicativi = true;
        }
      }
    }

    if (contieneIndicativi) {
      prenotazioniConPuntiIndicativi++;
    }

    const classe =
      statoPrenotazioneGeograficaNcc(
        origine,
        destinazione
      );

    classificazioni[classe] =
      (classificazioni[classe] ?? 0) + 1;
  }

  const totale = rows.length;

  const puntiTotali = totale * 2;

  const puntiDaValutare =
    puntiTotali - puntiApprovati;

  return {
    versione: 'V290.2E.2D.2B',

    totale,

    // Compatibilita con la precedente API.
    stati: [...stati.values()],

    classificazioni,

    pronte: classificazioni.PRONTA ?? 0,

    giaApprovate:
      classificazioni.GIA_APPROVATA ?? 0,

    puntiTotali,
    puntiApprovati,
    puntiDaValutare,
    puntiValidi,

    puntiIndicativiAccettati,

    puntiValidiSenzaAvvisoStradale:
      puntiValidi - puntiIndicativiAccettati,

    prenotazioniConPuntiIndicativi,

    puntiNonValidi:
      puntiDaValutare - puntiValidi,

    statiPunti,

    percentualeValidazione:
      puntiDaValutare > 0
        ? Math.round(
            puntiValidi /
            puntiDaValutare * 10000
          ) / 100
        : null,

    calcolatoIl:
      new Date(adesso).toISOString()
  };
}
