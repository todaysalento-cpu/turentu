
import {
  creaAutorizzazioneRoutingNcc
} from './ncc-routing-authorization.service.js';

export const NCC_GEOGRAFIA_BUDGET_LIMITS =
  Object.freeze({

    GEOCODING: Object.freeze({
      elementiSimulazione: 100,
      elementiOperatore: 500,
      elementiGlobali: 3000
    }),

    PLACES: Object.freeze({
      elementiSimulazione: 20,
      elementiOperatore: 100,
      elementiGlobali: 600
    })
  });

export function creaAutorizzazioneGeografiaNcc({

  operatoreId,

  simulazioneId,

  client,

  limits = NCC_GEOGRAFIA_BUDGET_LIMITS,

  plannerNamespace = 'ncc:planner:v23',

  geocodingNamespace = 'ncc:geocoding:v26',

  placesNamespace = 'ncc:places:v26'

} = {}) {

  const comune = {
    operatoreId,
    simulazioneId,
    client,
    plannerNamespace
  };

  const limiteEstesoProduzione =
    process.env.RENDER_SERVICE_ID === 'srv-d6smvunafjfc73f2vmd0' &&
    String(operatoreId) === '2' &&
    limits === NCC_GEOGRAFIA_BUDGET_LIMITS;
  const limitiGeocoding = limiteEstesoProduzione
    ? { ...limits.GEOCODING, elementiOperatore: limits.GEOCODING.elementiGlobali }
    : limits.GEOCODING;

  const derogaTest = process.env.NCC_GEO_TEST_BYPASS_ENABLED === 'true' && String(operatoreId) === '2';
  const estendiTest = limiti => derogaTest ? { ...limiti, elementiSimulazione: limiti.elementiGlobali, elementiOperatore: limiti.elementiGlobali } : limiti;

  const geocoding =
    creaAutorizzazioneRoutingNcc({

      ...comune,

      limits: estendiTest(limitiGeocoding),

      budgetNamespace: geocodingNamespace
    });

  const places =
    creaAutorizzazioneRoutingNcc({

      ...comune,

      limits: estendiTest(limits.PLACES),

      budgetNamespace: placesNamespace
    });

  const stats = {

    richiesteGeocoding: 0,

    richiestePlaces: 0,

    richiesteAeroporti: 0,

    autorizzateGeocoding: 0,

    autorizzatePlaces: 0,

    autorizzateAeroporti: 0,

    rifiuti: 0,

    errori: 0
  };

  async function autorizza(tipo) {

    if (
      ![
        'GEOCODING',
        'PLACES',
        'AEROPORTO'
      ].includes(tipo)
    ) {
      throw new Error(
        'NCC_GEO_TIPO_NON_VALIDO'
      );
    }

    const isPlaces = tipo === 'PLACES';

    if (isPlaces) {

      stats.richiestePlaces++;

    } else {

      stats.richiesteGeocoding++;

      if (tipo === 'AEROPORTO') {

        stats.richiesteAeroporti++;
      }
    }

    let r;

    try {

      r = await (
        isPlaces ? places : geocoding
      ).autorizza(1);

      if (
        !r ||
        typeof r.consentito !== 'boolean' ||
        r.elementiAutorizzati !==
          (r.consentito ? 1 : 0)
      ) {

        throw new Error(
          'NCC_GEO_AUTH_NON_VALIDA'
        );
      }

    } catch (e) {

      stats.errori++;

      throw e;
    }

    if (!r.consentito) {

      stats.rifiuti++;

      return {
        ...r,
        tipo
      };
    }

    if (isPlaces) {

      stats.autorizzatePlaces++;

    } else {

      stats.autorizzateGeocoding++;

      if (tipo === 'AEROPORTO') {

        stats.autorizzateAeroporti++;
      }
    }

    return {
      ...r,
      tipo
    };
  }

  return {

    autorizza,

    diagnostica: () => ({

      ...stats,

      geocoding: geocoding.diagnostica(),

      places: places.diagnostica()
    })
  };
}
