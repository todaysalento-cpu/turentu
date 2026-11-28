// NCC_GEO_DISTRIBUTED_V26
// NCC_GEO_INTEGRATION_V25
import { creaGeografiaGuardNcc } from './ncc-geografia-guard.service.js';


import fetch from 'node-fetch';
import { espandiIndirizzoStradaleNcc } from './ncc-espansione-strade.service.js';
import { confrontaStradeNcc } from './ncc-confronto-strade.service.js';
import { classificaCandidatiNcc } from './ncc-classificazione-geografica.service.js';

import {
  analizzaIndirizzoNcc
} from './ncc-normalizzazione-indirizzi.service.js';

import {
  verificaComuneNcc,
  verificaLocalitaIstatNcc
} from './ncc-validazione-territoriale.service.js';

import {
  normalizzaLocalita,
  riconosciLocalita
} from './ncc-locality-resolver.service.js';

const aliasStradePerComune = new Map([
  ['lecce', new Map([
    ['piazzetta tancredi', 'piazza tancredi'],
    ['piazzetta santa chiara', 'piazza vittorio emanuele ii']
  ])]
]);

function confrontoNomeStrada(nome, comune) {
  const normalizzato = normalizzaLocalita(nome);
  return aliasStradePerComune.get(normalizzaLocalita(comune))?.get(normalizzato) ?? normalizzato;
}

export const NCC_GEO_LIMITS = Object.freeze({
  maxGeocoding: 100,
  maxPlaces: 20,
  timeoutMs: 12000
});

function chiave(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function componente(result, tipo) {
  return result.address_components?.find(
    c => c.types?.includes(tipo)
  )?.long_name ?? null;
}

function comuneDaIndirizzo(indirizzo) {
  const parti = indirizzo.split(',')
    .map(p => p.trim())
    .filter(Boolean);

  if (
    parti.length >= 3 &&
    chiave(parti.at(-1)) === 'italia'
  ) {
    return parti.at(-2);
  }

  return null;
}

export function creaGeocodingNcc(
  db,
  {
    apiKey = process.env.GOOGLE_MAPS_API_KEY,
    limits = NCC_GEO_LIMITS,
    fetchImpl = fetch,
    signal = null,
    verificaAttiva = null,
    guard: guardEsterno = null
  } = {}
) {
  const guard = guardEsterno ??
    creaGeografiaGuardNcc({
      signal,
      verificaAttiva,
      limits
    });

  const cache = new Map();

  const stats = {
    geocoding: 0,
    places: 0,
    validati: 0,
    daVerificare: 0,
    fuoriComune: 0,
    nonTrovati: 0,
    erroriApi: 0,
    budgetEsaurito: false,
    richiesteInterrotte: 0
  };

  // NCC_GEO_HTTP_TIMEOUT_V26

  async function richiesta(url, options = {}) {

    guard.verifica();

    const controller = new AbortController();

    const signalHttp = AbortSignal.any([
      controller.signal,
      guard.signal
    ]);

    const timeoutMs = Math.min(
      limits.timeoutMs,
      guard.residuoMs()
    );

    const deadlineHttp =
      performance.now() + timeoutMs;

    let timer;
    let listener;

    function verificaHttp() {

      guard.verifica();

      if (
        performance.now() >= deadlineHttp &&
        !controller.signal.aborted
      ) {
        controller.abort(
          new Error('NCC_GEO_HTTP_TIMEOUT')
        );
      }

      signalHttp.throwIfAborted();
    }

    const annullamento = new Promise(
      (_, reject) => {

        listener = () => reject(
          signalHttp.reason ??
          new Error('NCC_GEO_HTTP_ABORT')
        );

        signalHttp.addEventListener(
          'abort',
          listener,
          { once: true }
        );

        if (signalHttp.aborted) {
          listener();
        }
      }
    );

    timer = setTimeout(() => {

      controller.abort(
        new Error('NCC_GEO_HTTP_TIMEOUT')
      );

    }, timeoutMs);

    try {

      const lavoro = Promise.resolve().then(
        async () => {

          verificaHttp();

          const response = await fetchImpl(
            url,
            {
              ...options,
              signal: signalHttp
            }
          );

          verificaHttp();

          if (!response.ok) {
            throw new Error(
              'HTTP_' + response.status
            );
          }

          const data = await response.json();

          verificaHttp();

          return data;
        }
      );

      const data = await Promise.race([
        lavoro,
        annullamento
      ]);

      verificaHttp();

      return data;

    } catch (error) {

      if (guard.signal.aborted) {

        stats.richiesteInterrotte++;

        throw guard.signal.reason;
      }

      guard.verifica();

      throw error;

    } finally {

      clearTimeout(timer);

      signalHttp.removeEventListener(
        'abort',
        listener
      );
    }
  }

  async function geocoding(indirizzo, suRifiuto) {

    guard.verifica();

    if (stats.geocoding >= limits.maxGeocoding) {
      suRifiuto?.('SESSIONE_LOCALE');
      stats.budgetEsaurito = true;
      return null;
    }

    if (!(await guard.autorizza('GEOCODING', suRifiuto))) {
      stats.budgetEsaurito = true;
      return null;
    }

    stats.geocoding++;

    const url = new URL(
      'https://maps.googleapis.com/maps/api/geocode/json'
    );

    url.searchParams.set('address', indirizzo);
    url.searchParams.set('components', 'country:IT');
    url.searchParams.set('language', 'it');
    url.searchParams.set('key', apiKey);

    const data = await richiesta(url.toString());

    if (data.status === 'ZERO_RESULTS') return [];

    if (data.status !== 'OK') {
      throw new Error(`GEOCODING_${data.status}`);
    }

    return data.results ?? [];
  }

  async function places(indirizzo) {

    guard.verifica();

    if (
      stats.places >= limits.maxPlaces ||
      !(await guard.autorizza('PLACES'))
    ) {
      stats.budgetEsaurito = true;
      return null;
    }

    stats.places++;

    const data = await richiesta(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': [
            'places.id',
            'places.displayName',
            'places.formattedAddress',
            'places.location'
          ].join(',')
        },
        body: JSON.stringify({
          textQuery: indirizzo,
          languageCode: 'it',
          regionCode: 'IT',
          maxResultCount: 3
        })
      }
    );

    return data.places ?? [];
  }

  async function valutaGeocoding(
    result,
    comuneAtteso,
    indirizzo,
    localitaGid = null
  ) {
    const lat = result.geometry?.location?.lat;
    const lon = result.geometry?.location?.lng;

    const territorio = await guard.attendi(
      () => verificaComuneNcc(db, {
        lat,
        lon,
        comuneAtteso
      })
    );

    guard.verifica();

    const localitaTerritoriale = localitaGid
      ? await guard.attendi(
          () => verificaLocalitaIstatNcc(db, {
            gid: localitaGid,
            lat,
            lon
          })
        )
      : null;

    guard.verifica();

    const precisione = result.geometry?.location_type;

    const civico = componente(result, 'street_number');
    const strada = componente(result, 'route');
    const paese = componente(result, 'country');

    const analisiStrada = typeof indirizzo === 'string' ? analizzaIndirizzoNcc(indirizzo) : indirizzo;
    const civicoRichiesto = analisiStrada.civico;
    const stradaRichiesta = civicoRichiesto
      ? analisiStrada.indirizzo.slice(0, -civicoRichiesto.length).replace(/[\s,]+$/, '')
      : analisiStrada.indirizzo;

    const civicoCoerente = Boolean(
      civicoRichiesto &&
      civico &&
      chiave(civicoRichiesto) === chiave(civico)
    );

    const confrontoStrada = confrontaStradeNcc(stradaRichiesta, strada);
    const stradaCoerente = Boolean(strada && (
      chiave(stradaRichiesta) === chiave(strada) ||
      confrontoNomeStrada(stradaRichiesta, comuneAtteso) === confrontoNomeStrada(strada, comuneAtteso) ||
      ['NOME_NORMALIZZATO', 'SPAZI_EQUIVALENTI', 'INIZIALI_COMPATIBILI'].includes(confrontoStrada.motivo)
    ));

    const affidabile =
      territorio.valido &&
      (!localitaGid || localitaTerritoriale?.valido === true) &&
      result.partial_match !== true &&
      precisione === 'ROOFTOP' &&
      chiave(paese) === 'italia' &&
      civicoCoerente &&
      stradaCoerente;

    return {
      fonte: 'GOOGLE_GEOCODING',
      placeId: result.place_id ?? null,
      indirizzo: result.formatted_address ?? null,
      lat,
      lon,
      precisione,
      civico,
      strada,
      civicoCoerente,
      stradaCoerente,
      stradaCompatibile: confrontoStrada.compatibile,
      motivoConfrontoStrada: confrontoStrada.motivo,
      partialMatch: result.partial_match === true,
      territorio,
      localitaTerritoriale,
      affidabile,
      puntoStradale: Boolean(comuneAtteso && territorio.valido &&
        (!localitaGid || localitaTerritoriale?.valido === true) &&
        chiave(paese) === 'italia' && stradaCoerente &&
        result.types?.includes('route') && ['GEOMETRIC_CENTER', 'APPROXIMATE'].includes(precisione))
    };
  }

  async function valutaPlaces(
    result,
    comuneAtteso,
    localitaGid = null
  ) {
    const lat = result.location?.latitude;
    const lon = result.location?.longitude;

    const territorio = await guard.attendi(
      () => verificaComuneNcc(db, {
        lat,
        lon,
        comuneAtteso
      })
    );

    guard.verifica();

    const localitaTerritoriale = localitaGid
      ? await guard.attendi(
          () => verificaLocalitaIstatNcc(db, {
            gid: localitaGid,
            lat,
            lon
          })
        )
      : null;

    guard.verifica();

    return {
      fonte: 'GOOGLE_PLACES',
      placeId: result.id ?? null,
      nome: result.displayName?.text ?? null,
      indirizzo: result.formattedAddress ?? null,
      lat,
      lon,
      territorio,
      localitaTerritoriale,

      // I risultati Places richiedono conferma.
      affidabile: false
    };
  }

  async function elabora(
    originale,
    comuneEsplicito
  ) {
    guard.verifica();

    const analisi = analizzaIndirizzoNcc(originale);
    const normalizzato = analisi.normalizzato;

    const comuneInput =
      comuneEsplicito ??
      analisi.comune ??
      comuneDaIndirizzo(normalizzato);

    const risoluzioneLocalita = await guard.attendi(
      () => riconosciLocalita(
        db,
        originale,
        { comune: comuneInput }
      )
    );

    guard.verifica();

    const frazioni = !comuneEsplicito && comuneInput && risoluzioneLocalita.stato === 'COMUNE_NON_COMPATIBILE'
      ? (risoluzioneLocalita.candidati ?? []).filter(candidato => candidato.comune?.nome &&
        normalizzaLocalita(candidato.nome) === normalizzaLocalita(comuneInput))
      : [];
    const frazione = frazioni.length === 1 ? frazioni[0] : null;
    const comuneAtteso = frazione?.comune.nome ?? comuneInput;
    const localitaRiconosciuta = frazione ?? risoluzioneLocalita.localita;
    const richiedePerimetroLocalita = localitaRiconosciuta?.nome &&
      normalizzaLocalita(localitaRiconosciuta.nome) !== normalizzaLocalita(comuneAtteso);
    const localitaGid = richiedePerimetroLocalita ? localitaRiconosciuta.gid ?? null : null;

    const localitaAmbigua =
      risoluzioneLocalita.stato === 'AMBIGUA' || frazioni.length > 1;

    const base = {
      originale,
      normalizzato,
      comuneAtteso,
      analisi,
      risoluzioneLocalita,
      valido: false
    };

    if (!apiKey) {
      stats.erroriApi++;

      return {
        ...base,
        stato: 'ERRORE_API',
        motivo: 'API_KEY_MANCANTE'
      };
    }

    try {
      let motivoBudget;
      const indirizzoRicerca = !localitaAmbigua && !analisi.ambiguo &&
        (!analisi.puntoInteresse || analisi.puntoInteresse === analisi.indirizzo)
        ? await guard.attendi(() => espandiIndirizzoStradaleNcc(db, analisi, comuneAtteso, comuneInput))
        : { ...analisi, query: normalizzato };
      const { query } = indirizzoRicerca;
      const risultati = await geocoding(query, motivo => { motivoBudget = motivo; });

      guard.verifica();

      if (risultati === null) {
        return {
          ...base,
          stato: 'DA_ELABORARE',
          motivo: ['OPERATORE', 'GLOBALE', 'SIMULAZIONE', 'SESSIONE_LOCALE'].includes(motivoBudget)
            ? 'BUDGET_GEOCODING_' + motivoBudget
            : 'BUDGET_GEOCODING'
        };
      }

      const candidati = await Promise.all(
        risultati.slice(0, 5).map(
          r => valutaGeocoding(
            r,
            comuneAtteso,
            indirizzoRicerca,
            localitaGid
          )
        )
      );

      // Una normalizzazione che modifica il significato
      // dell'indirizzo non deve essere approvata da sola.
      guard.verifica();

      const contieneAmbiguita = analisi.ambiguo;
      const verificaStrada = {
        query,
        espansioneOsm: query !== normalizzato,
        localitaGid,
        localitaRiconosciuta: localitaRiconosciuta?.nome ?? null,
        totaleRisultati: risultati.length,
        candidati: candidati.map(candidato => ({
          via: candidato.strada,
          civico: candidato.civico,
          precisione: candidato.precisione,
          stradaCoerente: candidato.stradaCoerente,
          civicoCoerente: candidato.civicoCoerente,
          confronto: candidato.motivoConfrontoStrada,
          territorio: candidato.territorio?.stato,
          localita: candidato.localitaTerritoriale?.stato,
          localitaIstat: candidato.localitaTerritoriale?.localita ?? null,
          parziale: candidato.partialMatch
        }))
      };

      if (
        risultati.length === 1 &&
        candidati[0]?.affidabile &&
        !contieneAmbiguita &&
        !localitaAmbigua &&
        (!analisi.puntoInteresse || indirizzoRicerca.tipoStradaRecuperato ||
          (analisi.civico && analisi.puntoInteresse !== analisi.indirizzo))
      ) {
        stats.validati++;

        return {
          ...base,
          valido: true,
          stato: 'VALIDATO_AUTO',
          punto: candidati[0]
        };
      }

      const candidatoStrada = candidati[0];
      if (risultati.length === 1 && candidatoStrada?.puntoStradale &&
        !contieneAmbiguita && !localitaAmbigua &&
        (!analisi.puntoInteresse || (analisi.riferimentoStradaleSeparato && !analisi.civico))) {
        stats.validati++;
        return {
          ...base, valido: true, stato: 'VALIDATO_AUTO',
          motivo: analisi.civico ? 'CIVICO_NON_RICONOSCIUTO' : 'CIVICO_MANCANTE',
          punto: { ...candidatoStrada, precisione: 'STRADA', posizioneIndicativa: true }
        };
      }

      const nomeUfficiale = confrontoNomeStrada(analisi.indirizzo, comuneAtteso);
      if (!analisi.civico && !analisi.puntoInteresse && !contieneAmbiguita && !localitaAmbigua &&
        nomeUfficiale !== normalizzaLocalita(analisi.indirizzo) &&
        risultati.length === 1 && risultati[0].types?.includes('point_of_interest') &&
        !risultati[0].types.includes('route') && candidati[0]?.territorio?.valido &&
        !candidati[0].partialMatch) {
        const queryUfficiale = [nomeUfficiale, comuneAtteso, 'Italia'].join(', ');
        const risultatiUfficiali = await geocoding(queryUfficiale);
        guard.verifica();
        if (risultatiUfficiali?.length === 1 && risultatiUfficiali[0].types?.includes('route')) {
          const punto = await valutaGeocoding(risultatiUfficiali[0], comuneAtteso,
            { indirizzo: nomeUfficiale, civico: null }, localitaGid);
          if (punto.puntoStradale && !punto.partialMatch) {
            stats.validati++;
            return {
              ...base, valido: true, stato: 'VALIDATO_AUTO', motivo: 'CIVICO_MANCANTE',
              punto: { ...punto, precisione: 'STRADA', posizioneIndicativa: true }
            };
          }
        }
      }

      // Fallback Places: ricerca candidati alternativi.
      guard.verifica();

      const alternativi = await places(
        analisi.queryPlaces || normalizzato
      );

      guard.verifica();

      if (alternativi) {
        const valutati = await Promise.all(
          alternativi.map(
            r => valutaPlaces(r, comuneAtteso, localitaGid)
          )
        );

        guard.verifica();

        candidati.push(...valutati);
      }

      for (const alternativa of analisi.alternative.slice(1,3)) {

        guard.verifica();
        const query = [alternativa, comuneAtteso, 'Italia'].filter(Boolean).join(', ');
        const altri = await geocoding(query);
        if (altri) {
          for (const r of altri.slice(0,3)) {
            candidati.push(await valutaGeocoding(
              r,
              comuneAtteso,
              query,
              localitaGid
            ));
          }
        }
      }

      guard.verifica();

      const perIdentita = new Map();

      for (const candidato of candidati) {
        const id = candidato.placeId ?? JSON.stringify([candidato.lat, candidato.lon]);
        const precedente = perIdentita.get(id);

        if (!precedente) {
          perIdentita.set(id, candidato);
          continue;
        }

        const geo = precedente.fonte === 'GOOGLE_GEOCODING'
          ? precedente
          : candidato.fonte === 'GOOGLE_GEOCODING'
            ? candidato
            : null;

        const poi = precedente.fonte === 'GOOGLE_PLACES'
          ? precedente
          : candidato.fonte === 'GOOGLE_PLACES'
            ? candidato
            : null;

        if (geo && poi) {
          perIdentita.set(id, {
            ...geo,
            nome: poi.nome ?? geo.nome,
            fonti: ['GOOGLE_GEOCODING', 'GOOGLE_PLACES']
          });
        }
      }

      const unici = [...perIdentita.values()];

      if (!unici.length) {
        if (stats.budgetEsaurito) {
          return {
            ...base,
            stato: 'DA_ELABORARE',
            motivo: 'BUDGET_PLACES'
          };
        }

        stats.nonTrovati++;

        return {
          ...base,
          stato: 'NON_TROVATO',
          motivo: 'NESSUN_INDIRIZZO_TROVATO',
          candidati: []
        };
      }

      if (
        unici.every(
          c => c.territorio.stato === 'FUORI_COMUNE'
        )
      ) {
        stats.fuoriComune++;

        return {
          ...base,
          stato: 'FUORI_COMUNE',
          ...classificaCandidatiNcc(unici, analisi),
          motivo: 'COORDINATE_FUORI_DAL_COMUNE_ATTESO'
        };
      }

      const classificazione = classificaCandidatiNcc(unici, analisi);
      stats.daVerificare++;

      return {
        ...base,
        stato: classificazione.candidati.length > 1 || contieneAmbiguita
          ? 'AMBIGUO'
          : 'DA_VERIFICARE',
        ...classificazione,
        verificaStrada,
        ...(localitaAmbigua && { motivo: 'LOCALITA_AMBIGUA' })
      };

    } catch (error) {

      guard.verifica();

      stats.erroriApi++;

      return {
        ...base,
        stato: 'ERRORE_API'
      };
    }
  }

  async function validaPunto(
    indirizzo,
    comuneAtteso = null
  ) {

    guard.verifica();
    if (
      typeof indirizzo !== 'string' ||
      !indirizzo.trim()
    ) {
      return Promise.resolve({
        valido: false,
        stato: 'NON_TROVATO'
      });
    }

    const id = JSON.stringify([
      indirizzo.trim(),
      comuneAtteso
    ]);

    if (!cache.has(id)) {
      cache.set(
        id,
        elabora(indirizzo, comuneAtteso)
      );
    }

    const risultato = await guard.attendi(
      () => cache.get(id)
    );

    guard.verifica();

    return risultato;
  }

  return {
    validaPunto,
    guard,
    diagnostica: () => ({
      ...stats,
      cache: cache.size,
      guard: guard.diagnostica()
    })
  };
}
