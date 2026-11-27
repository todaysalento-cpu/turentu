
import {
  statoPuntoGeograficoNcc
} from './ncc-geografia-stato.service.js';

import {
  risolviCatalogoNcc
} from './ncc-catalogo-luoghi.service.js';

// NCC_GEO_ANTI_BYPASS_V2902E2D2B

export function creaRiutilizzoGeograficoNcc(
  db,
  geografia,
  guard
) {
  const cache = new Map();
  const cacheCatalogo = new Map();

  const stats = {
    riutilizzatiAuto: 0,
    riutilizzatiManuali: 0,
    riutilizzatiCatalogo: 0,
    manualiDaRiconfermare: 0,
    nuoveElaborazioni: 0,
    cacheHit: 0,
    automaticiScaduti: 0,
    catalogoDaRivalutare: 0,
    controlliCatalogo: 0,
    cacheHitCatalogo: 0,
    blocchiCatalogo: 0,
    vincoliCatalogoRiutilizzati: 0
  };

  async function resolverCatalogo(
    database,
    indirizzo,
    ruolo
  ) {
    guard.verifica();

    const chiave = JSON.stringify([
      indirizzo,
      ruolo
    ]);

    if (cacheCatalogo.has(chiave)) {
      stats.cacheHitCatalogo++;

      const risultato = cacheCatalogo.get(chiave);

      guard.verifica();

      return risultato;
    }

    stats.controlliCatalogo++;

    const risultato = await risolviCatalogoNcc(
      database,
      indirizzo,
      ruolo
    );

    guard.verifica();

    cacheCatalogo.set(chiave, risultato);

    return risultato;
  }

  async function valida(row, ruolo) {
    guard.verifica();

    if (!['origine', 'destinazione'].includes(ruolo)) {
      throw new Error('Ruolo non valido');
    }

    const indirizzo = row[ruolo];

    const stato = row[ruolo + '_stato_geo'];

    const verifica = await guard.attendi(
      () => statoPuntoGeograficoNcc(
        db,
        row,
        ruolo,
        {
          risolviCatalogo: resolverCatalogo
        }
      )
    );

    guard.verifica();

    if (verifica.utilizzabile) {

      // NCC_PRECISIONE_STRADA_V2
      const dettaglio =
        row[ruolo + '_dettaglio_geo'] ?? {};

      const posizioneIndicativa =
        stato === 'VALIDATO_MANUALE' &&
        dettaglio.precisione === 'STRADA' &&
        dettaglio.posizioneIndicativa === true &&
        dettaglio.confermatoDaOperatore === true;

      if (verifica.puntoOperativoId != null) {
        stats.vincoliCatalogoRiutilizzati++;
      }
      if (stato === 'VALIDATO_AUTO') {
        stats.riutilizzatiAuto++;
      }

      if (stato === 'VALIDATO_MANUALE') {
        stats.riutilizzatiManuali++;
      }

      if (stato === 'VALIDATO_CATALOGO') {
        stats.riutilizzatiCatalogo++;
      }

      return {
        stato,
        valido: true,
        utilizzabileSimulazione: true,
        indicativo: false,
        riutilizzato: true,

        posizioneIndicativa,

        precisione:
          dettaglio.precisione ?? null,

        numeroCivicoMancante:
          posizioneIndicativa &&
          dettaglio.numeroCivicoMancante === true,

        numeroCivicoNonRiconosciuto:
          posizioneIndicativa &&
          dettaglio.numeroCivicoNonRiconosciuto === true,

        // NCC_GEO_VINCOLI_V2902E2D1
        tipiVeicoloAmmessi:
          verifica.puntoOperativoId != null
            ? (
                verifica.tipiVeicoloAmmessi === null
                  ? null
                  : Array.isArray(
                      verifica.tipiVeicoloAmmessi
                    )
                    ? [...verifica.tipiVeicoloAmmessi]
                    : []
              )
            : null,

        originale: indirizzo,

        lat: row[ruolo + '_lat'],
        lon: row[ruolo + '_lon'],

        fonte: row[ruolo + '_fonte_geo'],

        placeId:
          row[ruolo + '_place_id'] ?? null,

        puntoOperativoId:
          verifica.puntoOperativoId ??
          row[ruolo + '_punto_operativo_id'] ??
          null
      };
    }

    if (verifica.bloccoCatalogo === true) {
      stats.blocchiCatalogo++;

      if (stato === 'VALIDATO_MANUALE') {
        stats.manualiDaRiconfermare++;
      }

      return {
        stato: verifica.statoEffettivo,
        valido: false,
        utilizzabileSimulazione: false,
        indicativo: false,
        tipiVeicoloAmmessi: [],
        motivo: verifica.motivoCatalogo ??
          verifica.statoEffettivo
      };
    }

    // Una validazione manuale non deve essere
    // sostituita automaticamente dal resolver.

    if (stato === 'VALIDATO_MANUALE') {
      stats.manualiDaRiconfermare++;

      return {
        stato: 'MANUALE_DA_RICONFERMARE',
        valido: false,
        utilizzabileSimulazione: false,
        indicativo: false,
        motivo: verifica.statoEffettivo
      };
    }

    if (stato === 'VALIDATO_AUTO') {
      stats.automaticiScaduti++;
    }

    if (stato === 'VALIDATO_CATALOGO') {
      stats.catalogoDaRivalutare++;
    }

    // La cache riguarda esclusivamente le nuove
    // elaborazioni, non le coordinate persistite.

    const chiave = JSON.stringify([
      indirizzo,
      ruolo
    ]);

    // NCC_GEO_CACHE_SICURA_V2902D3C
    // Avvio del resolver sotto il controllo
    // del guard. Cache dei soli esiti completati.

    guard.verifica();

    if (cache.has(chiave)) {
      stats.cacheHit++;

      const risultato = cache.get(chiave);

      guard.verifica();

      return risultato;
    }

    stats.nuoveElaborazioni++;

    const risultato = await guard.attendi(
      () => geografia.validaPunto(
        indirizzo,
        ruolo
      )
    );

    guard.verifica();

    cache.set(chiave, risultato);

    return risultato;
  }

  return {
    valida,

    diagnostica() {
      return {
        ...stats,

        riutilizzatiTotali:
          stats.riutilizzatiAuto +
          stats.riutilizzatiManuali +
          stats.riutilizzatiCatalogo,

        indirizziElaborati: cache.size,
        indirizziCatalogoControllati:
          cacheCatalogo.size
      };
    }
  };
}
