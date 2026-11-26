
import { performance } from 'node:perf_hooks';

// NCC_GEOGRAFIA_GUARD_V26

export const NCC_GEOGRAFIA_GUARD_LIMITS =
  Object.freeze({
    maxGeocoding: 100,
    maxPlaces: 20,
    deadlineMs: 120000
  });

export function creaGeografiaGuardNcc({

  signal = null,

  verificaAttiva = null,

  autorizzaDistribuita = null,

  autorizzazioneRigorosa = false,

  limits = NCC_GEOGRAFIA_GUARD_LIMITS

} = {}) {

  const config = {
    ...NCC_GEOGRAFIA_GUARD_LIMITS,
    ...limits
  };

  for (const nome of [
    'maxGeocoding',
    'maxPlaces',
    'deadlineMs'
  ]) {

    if (
      !Number.isSafeInteger(config[nome]) ||
      config[nome] < 0 ||
      (
        nome === 'deadlineMs' &&
        config[nome] === 0
      )
    ) {
      throw new Error(
        'NCC_GEO_LIMITE_NON_VALIDO_' + nome
      );
    }
  }

  if (
    verificaAttiva !== null &&
    typeof verificaAttiva !== 'function'
  ) {
    throw new Error(
      'NCC_GEO_VERIFICA_NON_VALIDA'
    );
  }

  if (
    signal !== null &&
    !(signal instanceof AbortSignal)
  ) {
    throw new Error(
      'NCC_GEO_SIGNAL_NON_VALIDO'
    );
  }

  if (
    autorizzaDistribuita !== null &&
    typeof autorizzaDistribuita !== 'function'
  ) {
    throw new Error(
      'NCC_GEO_AUTH_NON_VALIDA'
    );
  }

  if (
    autorizzazioneRigorosa &&
    !autorizzaDistribuita
  ) {
    throw new Error(
      'NCC_GEO_AUTH_OBBLIGATORIA'
    );
  }

  const controller = new AbortController();

  const inizio = performance.now();

  const deadline =
    inizio + config.deadlineMs;

  let timer;

  const stats = {

    geocoding: 0,

    places: 0,

    aeroporti: 0,

    rifiutiGeocoding: 0,

    rifiutiPlaces: 0,

    richiesteDistribuite: 0,

    autorizzateDistribuite: 0,

    rifiutiDistribuiti: 0,

    erroriDistribuiti: 0,

    esitiDistribuitiIncerti: 0,

    interrotta: false,

    motivoInterruzione: null

  };

  function interrompi(
    motivo = 'NCC_GEOGRAFIA_INTERROTTA'
  ) {

    if (controller.signal.aborted) return;

    stats.interrotta = true;

    stats.motivoInterruzione =
      String(motivo);

    clearTimeout(timer);

    signal?.removeEventListener(
      'abort',
      onAbort
    );

    controller.abort(
      Object.assign(
        new Error(String(motivo)),
        { status: 503 }
      )
    );
  }

  function onAbort() {

    interrompi(
      signal?.reason?.message ??
      'NCC_SESSIONE_INTERROTTA'
    );
  }

  function verifica() {

    if (controller.signal.aborted) {

      throw controller.signal.reason;
    }

    if (signal?.aborted) {

      onAbort();

      throw controller.signal.reason;
    }

    if (performance.now() >= deadline) {

      interrompi(
        'NCC_GEOGRAFIA_DEADLINE'
      );

      throw controller.signal.reason;
    }

    try {

      verificaAttiva?.();

    } catch (e) {

      interrompi(
        e?.message ??
        'NCC_SESSIONE_NON_ATTIVA'
      );

      throw controller.signal.reason;
    }

    controller.signal.throwIfAborted();
  }

  function riservaLocale(tipo) {

    verifica();

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

    if (tipo === 'PLACES') {

      if (
        stats.places >= config.maxPlaces
      ) {

        stats.rifiutiPlaces++;

        return false;
      }

      stats.places++;

      return true;
    }

    if (
      stats.geocoding >= config.maxGeocoding
    ) {

      stats.rifiutiGeocoding++;

      return false;
    }

    stats.geocoding++;

    if (tipo === 'AEROPORTO') {

      stats.aeroporti++;
    }

    return true;
  }

  function riserva(tipo) {

    verifica();

    if (
      autorizzazioneRigorosa ||
      autorizzaDistribuita
    ) {
      throw new Error(
        'NCC_GEO_USARE_AUTORIZZA'
      );
    }

    return riservaLocale(tipo);
  }

  async function autorizza(tipo) {

    verifica();

    // Prenotazione locale prima di qualsiasi await.
    if (!riservaLocale(tipo)) {
      return false;
    }

    if (!autorizzaDistribuita) {

      verifica();

      return true;
    }

    stats.richiesteDistribuite++;

    let risultato;

    try {

      risultato = await attendi(() => {

        verifica();

        return autorizzaDistribuita(tipo);
      });

      verifica();

      if (
        !risultato ||
        typeof risultato.consentito !== 'boolean' ||
        risultato.elementiAutorizzati !==
          (risultato.consentito ? 1 : 0)
      ) {

        throw new Error(
          'NCC_GEO_AUTH_RISPOSTA_NON_VALIDA'
        );
      }

    } catch (e) {

      stats.erroriDistribuiti++;

      stats.esitiDistribuitiIncerti++;

      interrompi(
        e?.message ??
        'NCC_GEO_AUTH_FALLITA'
      );

      verifica();

      throw e;
    }

    if (!risultato.consentito) {

      stats.rifiutiDistribuiti++;

      if (risultato.motivo === 'LEASE_PERSO') {

        interrompi('NCC_LEASE_PERSO');

        verifica();
      }

      return false;
    }

    stats.autorizzateDistribuite++;

    verifica();

    return true;
  }

  function residuoMs() {

    verifica();

    return Math.max(
      1,
      Math.ceil(
        deadline - performance.now()
      )
    );
  }

  async function attendi(fn) {

    verifica();

    let listener;

    const annullamento = new Promise(
      (_, reject) => {

        listener = () =>
          reject(controller.signal.reason);

        controller.signal.addEventListener(
          'abort',
          listener,
          { once: true }
        );
      }
    );

    try {

      const risultato = await Promise.race([

        Promise.resolve().then(() => {

          verifica();

          return fn();
        }),

        annullamento
      ]);

      verifica();

      return risultato;

    } finally {

      controller.signal.removeEventListener(
        'abort',
        listener
      );
    }
  }

  if (signal?.aborted) {

    onAbort();

  } else {

    signal?.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );

    timer = setTimeout(
      () => interrompi(
        'NCC_GEOGRAFIA_DEADLINE'
      ),
      config.deadlineMs
    );

    timer.unref?.();
  }

  return {

    signal: controller.signal,

    verifica,

    riserva,

    autorizza,

    residuoMs,

    attendi,

    interrompi,

    diagnostica: () => ({

      ...stats,

      limits: { ...config },

      autorizzazioneDistribuita:
        Boolean(autorizzaDistribuita),

      autorizzazioneRigorosa,

      geocodingResiduo: Math.max(
        0,
        config.maxGeocoding -
        stats.geocoding
      ),

      placesResiduo: Math.max(
        0,
        config.maxPlaces -
        stats.places
      ),

      durataMs: Math.round(
        performance.now() - inizio
      ),

      residuoMs: Math.max(
        0,
        Math.floor(
          deadline - performance.now()
        )
      )
    })
  };
}
