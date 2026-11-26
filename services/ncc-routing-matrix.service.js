import { normalizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';

import fetch from 'node-fetch';
import { performance } from 'node:perf_hooks';
import { resolveLocation } from '../routes/distanza.route.js';

export const NCC_ROUTING_LIMITS = Object.freeze({
  maxGeocoding: 200,
  maxElements: 1000,
  batchSize: 25,
  batchWindowMs: 10,
  concurrency: 4,
  timeoutMs: 12000,
  deadlineMs: 120000
});

const key = value =>
  String(value).trim().replace(/\s+/g, ' ').toLowerCase();

const coordKey = c => `${c.lat},${c.lon}`;

export function distanzaGeografica(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) *
    Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;

  return 6371 * 2 *
    Math.asin(Math.sqrt(Math.min(1, h)));
}

export function creaRoutingNcc({
  limits = NCC_ROUTING_LIMITS,
  locate = resolveLocation,
  fetchImpl = fetch,
  autorizzaRouting = null,
  signal = null,
  verificaAttiva = null,
  autorizzazioneRigorosa = false,
  richiediAutorizzazione = false,
  timeoutAutorizzazioneMs = 3000,
  apiKey = process.env.GOOGLE_MAPS_API_KEY
} = {}) {
  // NCC_ROUTING_AUTH_V23

  if (
    autorizzaRouting !== null &&
    typeof autorizzaRouting !== 'function'
  ) {
    throw new Error('NCC_AUTORIZZAZIONE_NON_VALIDA');
  }

  if (
    richiediAutorizzazione &&
    typeof autorizzaRouting !== 'function'
  ) {
    throw new Error('NCC_AUTORIZZAZIONE_OBBLIGATORIA');
  }

  if (
    !Number.isSafeInteger(timeoutAutorizzazioneMs) ||
    timeoutAutorizzazioneMs <= 0
  ) {
    throw new Error('NCC_TIMEOUT_AUTH_NON_VALIDO');
  }

  // NCC_ROUTING_ABORT_V25
  // NCC_ROUTING_GEO_BLOCK_V26

  if (
    verificaAttiva !== null &&
    typeof verificaAttiva !== 'function'
  ) {
    throw new Error('NCC_VERIFICA_SESSIONE_NON_VALIDA');
  }

  if (
    signal !== null &&
    (
      typeof signal.addEventListener !== 'function' ||
      typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new Error('NCC_SIGNAL_NON_VALIDO');
  }

  if (
    autorizzazioneRigorosa &&
    typeof autorizzaRouting !== 'function'
  ) {
    throw new Error('NCC_AUTORIZZAZIONE_OBBLIGATORIA');
  }

  let autorizzazioneBloccata = false;
  let elementiRiservati = 0;
  let interrotto = false;

  const controllerRouting = new AbortController();
  const signalRouting = controllerRouting.signal;

  const lavoriAttivi = new Set();

  const coordinates = new Map();
  const routes = new Map();

  // NCC_AUTO_BATCH_V21
  const pendingOrigins = new Map();
  const queue = [];
  const deadline = performance.now() + limits.deadlineMs;

  let active = 0;

  const stats = {
    geocoding: 0,
    geocodingFalliti: 0,

    geocodingAutonomoBloccato: 0,
    elementi: 0,
    richiesteMatrix: 0,
    cacheHit: 0,
    cacheMiss: 0,
    batchAutomatici: 0,
    batchElementi: 0,
    batchMassimo: 0,
    routingFalliti: 0,
    budgetEsaurito: false,
    autorizzazioniRouting: 0,
    elementiAutorizzati: 0,
    batchParziali: 0,
    elementiEsclusiBudgetLocale: 0,
    elementiEsclusiBudgetRedis: 0,
    elementiAutorizzatiNonInviati: 0,
    autorizzazioniRifiutate: 0,
    erroriAutorizzazione: 0,
    elementiNonAutorizzati: 0,
    ultimoRifiutoAutorizzazione: null,
    interrotta: false,
    motivoInterruzione: null,
    lavoriAnnullati: 0,
    batchPendentiAnnullati: 0,
    autorizzazioniEsitoIncerto: 0,
    elementiAutorizzazioneIncerta: 0
  };

  function interrompi(motivo = 'NCC_ROUTING_INTERROTTO') {

    if (interrotto) return;

    interrotto = true;
    autorizzazioneBloccata = true;

    stats.interrotta = true;
    stats.motivoInterruzione = String(motivo);

    signal?.removeEventListener(
      'abort',
      onSessionAbort
    );

    controllerRouting.abort(
      new Error(String(motivo))
    );

    while (queue.length) {

      const job = queue.shift();

      stats.lavoriAnnullati++;
      job.resolve(null);
    }

    for (const group of pendingOrigins.values()) {

      clearTimeout(group.timer);

      stats.batchPendentiAnnullati++;

      for (const item of group.entries.values()) {
        item.resolve(null);
      }
    }

    pendingOrigins.clear();

    for (const job of lavoriAttivi) {
      stats.lavoriAnnullati++;
      job.resolve(null);
    }
  }

  function onSessionAbort() {

    interrompi(
      signal?.reason?.message ??
      'NCC_SESSIONE_INTERROTTA'
    );
  }

  function operativa() {

    if (interrotto) return false;

    if (signal?.aborted) {
      onSessionAbort();
      return false;
    }

    if (performance.now() >= deadline) {

      stats.budgetEsaurito = true;

      interrompi('NCC_ROUTING_DEADLINE');

      return false;
    }

    try {
      verificaAttiva?.();
    } catch (e) {

      interrompi(
        e?.message ?? 'NCC_SESSIONE_NON_ATTIVA'
      );

      return false;
    }

    return !interrotto;
  }

  function pump() {
    while (active < limits.concurrency && queue.length) {
      const job = queue.shift();

      if (!operativa()) {
        job.resolve(null);
        continue;
      }

      active++;
      lavoriAttivi.add(job);

      Promise.resolve()
        .then(() => operativa() ? job.run() : null)
        .then(
          value => job.resolve(
            operativa() ? value : null
          ),
          () => job.resolve(null)
        )
        .finally(() => {

          lavoriAttivi.delete(job);

          active--;

          pump();
        });
    }
  }

  function schedule(run) {

    if (!operativa()) {
      return Promise.resolve(null);
    }

    return new Promise(resolve => {
      queue.push({ run, resolve });
      pump();
    });
  }

  function registraCoordinate(name, c) {

    if (!operativa()) {
      throw new Error('NCC_ROUTING_INTERROTTO');
    }
    if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180 || (c.lat === 0 && c.lon === 0)) {
      throw new Error('Coordinate non valide');
    }
    const id = key(name);
    if (coordinates.has(id)) throw new Error('Coordinate gia registrate');
    coordinates.set(id, Promise.resolve({ lat: c.lat, lon: c.lon }));
  }

  async function coordinate(name) {

    if (!operativa()) return null;
    const id = key(name);

    if (coordinates.has(id)) {
      const cached = await coordinates.get(id);

      return operativa() ? cached : null;
    }

    // In modalita rigorosa sono ammesse
    // esclusivamente coordinate registrate.

    if (autorizzazioneRigorosa) {

      stats.geocodingAutonomoBloccato++;

      return null;
    }

    if (
      stats.geocoding >= limits.maxGeocoding ||
      performance.now() >= deadline
    ) {
      stats.budgetEsaurito = true;
      return Promise.resolve(null);
    }

    const result = schedule(async () => {
      try {
        if (!operativa()) return null;

        if (stats.geocoding >= limits.maxGeocoding) {

          stats.budgetEsaurito = true;

          return null;
        }

        stats.geocoding++;

        const c = await locate(
          normalizzaIndirizzoNcc(name),
          { signal: signalRouting }
        );

        if (!operativa()) return null;

        if (
          !Number.isFinite(c?.lat) ||
          !Number.isFinite(c?.lon) ||
          Math.abs(c.lat) > 90 ||
          Math.abs(c.lon) > 180 ||
          (c.lat === 0 && c.lon === 0)
        ) {
          throw new Error('Coordinate non valide');
        }

        return c;
      } catch {
        stats.geocodingFalliti++;
        return null;
      }
    });

    coordinates.set(id, result);

    const valore = await result;

    return operativa() ? valore : null;
  }

  // NCC_PARTIAL_BATCH_V24

  async function verificaAutorizzazione(n) {

    if (!operativa() || autorizzazioneBloccata) {
      stats.elementiNonAutorizzati += n;
      return 0;
    }

    if (!autorizzaRouting) return n;

    let timer;
    let richiestaAvviata = false;

    try {
      const remaining = deadline - performance.now();

      if (remaining <= 0) {
        stats.budgetEsaurito = true;
        stats.elementiNonAutorizzati += n;
        return 0;
      }

      const risultato = await Promise.race([
        Promise.resolve().then(
          () => {

            if (!operativa() || autorizzazioneBloccata) {
              return {
                consentito: false,
                motivo: 'SESSIONE_INTERROTTA',
                elementiAutorizzati: 0
              };
            }

            richiestaAvviata = true;

            return autorizzaRouting(n);
          }
        ),

        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(
              new Error('NCC_AUTH_TIMEOUT')
            ),
            Math.min(
              timeoutAutorizzazioneMs,
              remaining
            )
          );
        })
      ]);

      if (risultato?.consentito === false) {

        const motivo = String(
          risultato.motivo ?? 'RIFIUTATA'
        );

        stats.autorizzazioniRifiutate++;
        stats.elementiNonAutorizzati += n;
        stats.elementiEsclusiBudgetRedis += n;
        stats.ultimoRifiutoAutorizzazione = motivo;

        if (motivo === 'LEASE_PERSO') {
          autorizzazioneBloccata = true;
        } else {
          stats.budgetEsaurito = true;
        }

        return 0;
      }

      if (risultato?.consentito !== true) {
        throw new Error(
          'NCC_AUTH_RISPOSTA_NON_VALIDA'
        );
      }

      if (
        autorizzazioneRigorosa &&
        risultato.elementiAutorizzati === undefined
      ) {
        throw new Error('NCC_AUTH_ELEMENTI_OBBLIGATORI');
      }

      // Compatibilita con autorizzazioni V23.
      const autorizzati =
        risultato.elementiAutorizzati === undefined
          ? n
          : risultato.elementiAutorizzati;

      if (
        !Number.isSafeInteger(autorizzati) ||
        autorizzati <= 0 ||
        autorizzati > n
      ) {
        throw new Error(
          'NCC_AUTH_ELEMENTI_NON_VALIDI'
        );
      }

      stats.autorizzazioniRouting++;
      stats.elementiAutorizzati += autorizzati;

      if (autorizzati < n) {
        stats.budgetEsaurito = true;

        stats.elementiNonAutorizzati +=
          n - autorizzati;

        stats.elementiEsclusiBudgetRedis +=
          n - autorizzati;
      }

      if (!operativa() || autorizzazioneBloccata) {
        stats.elementiAutorizzatiNonInviati +=
          autorizzati;

        return 0;
      }

      return autorizzati;

    } catch (e) {

      if (richiestaAvviata) {
        stats.autorizzazioniEsitoIncerto++;
        stats.elementiAutorizzazioneIncerta += n;
      }

      autorizzazioneBloccata = true;

      stats.erroriAutorizzazione++;
      stats.elementiNonAutorizzati += n;

      stats.ultimoRifiutoAutorizzazione =
        e?.message ?? 'NCC_AUTH_ERROR';

      return 0;

    } finally {
      clearTimeout(timer);
    }
  }

  async function requestMatrix(origin, destinations) {

    const richiesti = destinations.length;
    const remaining = deadline - performance.now();

    if (
      !operativa() ||
      remaining <= 0 ||
      autorizzazioneBloccata
    ) {
      return null;
    }

    const residuoLocale = Math.max(
      0,
      limits.maxElements -
      stats.elementi -
      elementiRiservati
    );

    const candidati = Math.min(
      richiesti,
      residuoLocale
    );

    if (candidati < richiesti) {
      stats.budgetEsaurito = true;

      stats.elementiEsclusiBudgetLocale +=
        richiesti - candidati;
    }

    if (candidati <= 0) return null;

    if (!apiKey) {
      stats.routingFalliti += candidati;
      return null;
    }

    elementiRiservati += candidati;

    let daInviare = 0;

    try {

      const autorizzati =
        await verificaAutorizzazione(candidati);

      if (!autorizzati) return null;

      if (
        !operativa() ||
        autorizzazioneBloccata
      ) {

        stats.elementiAutorizzatiNonInviati +=
          autorizzati;

        return null;
      }

      daInviare = autorizzati;

    } finally {

      elementiRiservati -= candidati;
    }

    // Nessun await tra rilascio prenotazione
    // e contabilizzazione degli elementi inviati.

    if (daInviare < richiesti) {
      stats.batchParziali++;
    }

    // Invia esclusivamente le destinazioni
    // effettivamente autorizzate.

    destinations = destinations.slice(
      0,
      daInviare
    );

    stats.elementi += destinations.length;
    stats.richiesteMatrix++;

    const controller = new AbortController();

    const signalHttp = AbortSignal.any([
      controller.signal,
      signalRouting
    ]);

    const timer = setTimeout(
      () => controller.abort(),
      Math.min(
        limits.timeoutMs,
        Math.max(1, deadline - performance.now())
      )
    );

    try {
      const url = new URL(
        'https://maps.googleapis.com/maps/api/distancematrix/json'
      );

      url.searchParams.set('origins', coordKey(origin));
      url.searchParams.set(
        'destinations',
        destinations.map(coordKey).join('|')
      );
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('units', 'metric');
      url.searchParams.set('key', apiKey);

      if (!operativa() || signalHttp.aborted) {

        stats.elementi -= destinations.length;
        stats.richiesteMatrix--;

        if (autorizzaRouting) {
          stats.elementiAutorizzatiNonInviati +=
            destinations.length;
        }

        return null;
      }

      const response = await fetchImpl(url.toString(), {
        signal: signalHttp
      });

      if (!response.ok) {
        throw new Error('HTTP_ROUTING');
      }

      const data = await response.json();

      if (!operativa() || signalHttp.aborted) {
        return null;
      }

      if (data.status !== 'OK') {
        throw new Error('PROVIDER_ROUTING');
      }

      return Array.from(
        { length: richiesti },
        (_, index) => {

        if (index >= destinations.length) {
          return null;
        }
        const e = data.rows?.[0]?.elements?.[index];

        if (
          e?.status !== 'OK' ||
          !Number.isFinite(e.distance?.value) ||
          !Number.isFinite(e.duration?.value) ||
          e.distance.value <= 0 ||
          e.duration.value <= 0
        ) {
          stats.routingFalliti++;
          return null;
        }

        return {
          distanzaKm: e.distance.value / 1000,
          durataMs: e.duration.value * 1000
        };
      });
    } catch {
      stats.routingFalliti += destinations.length;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }


  function flushOrigin(id) {

    if (!operativa()) return;
    const group = pendingOrigins.get(id);

    if (!group) return;

    pendingOrigins.delete(id);
    clearTimeout(group.timer);

    const entries = [...group.entries.values()];

    for (
      let i = 0;
      i < entries.length;
      i += limits.batchSize
    ) {
      const batch = entries.slice(
        i, i + limits.batchSize
      );

      stats.batchAutomatici++;
      stats.batchElementi += batch.length;

      stats.batchMassimo = Math.max(
        stats.batchMassimo,
        batch.length
      );

      schedule(() =>
        requestMatrix(
          group.origin,
          batch.map(item => item.destination)
        )
      ).then(values => {
        batch.forEach((item, index) => {
          item.resolve(values?.[index] ?? null);
        });
      });
    }
  }

  function enqueueRoute(origin, destination) {

    if (!operativa()) {
      return Promise.resolve(null);
    }
    const originId = coordKey(origin);

    const id =
      originId + '|' + coordKey(destination);

    if (routes.has(id)) {
      stats.cacheHit++;
      return routes.get(id);
    }

    stats.cacheMiss++;

    let resolve;

    const promise = new Promise(r => {
      resolve = r;
    });

    routes.set(id, promise);

    let group = pendingOrigins.get(originId);

    if (!group) {
      group = {
        origin,
        entries: new Map(),
        timer: null
      };

      pendingOrigins.set(originId, group);

      group.timer = setTimeout(
        () => flushOrigin(originId),
        Math.max(
          0,
          Math.min(
            limits.batchWindowMs ?? 10,
            deadline - performance.now()
          )
        )
      );
    }

    group.entries.set(id, {
      destination,
      resolve
    });

    if (group.entries.size >= limits.batchSize) {
      flushOrigin(originId);
    }

    return promise;
  }

  async function matrix(from, destinations) {
    const origin = await coordinate(from);

    if (!origin || !operativa()) {
      return destinations.map(() => null);
    }

    const resolved = await Promise.all(
      destinations.map(coordinate)
    );

    if (!operativa()) {
      return destinations.map(() => null);
    }

    const risultati = await Promise.all(
      resolved.map(destination => {
        if (!destination) return null;

        if (
          coordKey(origin) === coordKey(destination)
        ) {
          return {
            distanzaKm: 0,
            durataMs: 0
          };
        }

        return enqueueRoute(
          origin,
          destination
        );
      })
    );

    return operativa()
      ? risultati
      : destinations.map(() => null);
  }

  async function tratta(from, to) {
    return (await matrix(from, [to]))[0];
  }

  async function vicini(a, b, raggioKm = 5) {
    const [ca, cb] = await Promise.all([
      coordinate(a),
      coordinate(b)
    ]);

    if (!operativa() || !ca || !cb) return false;

    return distanzaGeografica(ca, cb) <= raggioKm;
  }

  if (signal?.aborted) {
    onSessionAbort();
  } else {
    signal?.addEventListener(
      'abort',
      onSessionAbort,
      { once: true }
    );
  }

  return {
    coordinate,
    registraCoordinate,
    interrompi,
    signal: signalRouting,
    matrix,
    tratta,
    vicini,
    diagnostica: () => ({
      ...stats,
      elementiRiservati,
      limiteElementi: limits.maxElements,
      elementiResiduiLocali: Math.max(0, limits.maxElements - stats.elementi - elementiRiservati),
      tempoResiduoMs: Math.max(0, Math.floor(deadline - performance.now())),
      lavoriAttivi: lavoriAttivi.size,
      lavoriInCoda: queue.length,
      autorizzazioneRigorosa,

      geocodingAutonomoConsentito:
        !autorizzazioneRigorosa,
      autorizzazioneAttiva:
        typeof autorizzaRouting === 'function',
      autorizzazioneBloccata,
      coordinateCache: coordinates.size,
      tratteCache: routes.size,
      originiInAttesa: pendingOrigins.size,
      elementiMediPerRichiesta:
        stats.richiesteMatrix
          ? stats.elementi / stats.richiesteMatrix
          : 0
    })
  };
}
