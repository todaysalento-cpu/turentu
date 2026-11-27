
import { performance } from 'node:perf_hooks';

import {
  creaPlannerLockNcc,
  NCC_PLANNER_LIMITS
} from './ncc-planner-lock.service.js';

import {
  creaAutorizzazioneRoutingNcc
} from './ncc-routing-authorization.service.js';

import {
  creaAutorizzazioneGeografiaNcc
} from './ncc-geografia-authorization.service.js';

// NCC_PLANNER_SESSION_V26

export const NCC_SESSION_LIMITS = Object.freeze({
  heartbeatMs: 30000,
  timeoutRedisMs: 3000,
  durataMassimaMs: 300000
});

function erroreSessione(motivo) {
  return Object.assign(
    new Error(motivo),
    { status: 503 }
  );
}

async function conTimeout(fn, ms) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(fn),

      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(
            erroreSessione('NCC_SESSION_TIMEOUT')
          ),
          ms
        );
      })
    ]);

  } finally {
    clearTimeout(timer);
  }
}

export function creaSessionManagerNcc({
  planner = creaPlannerLockNcc(),
  creaAutorizzazione = creaAutorizzazioneRoutingNcc,

  creaAutorizzazioneGeografia =
    creaAutorizzazioneGeografiaNcc,
  limits = NCC_SESSION_LIMITS
} = {}) {

  for (const nome of [
    'heartbeatMs',
    'timeoutRedisMs',
    'durataMassimaMs'
  ]) {
    if (
      !Number.isSafeInteger(limits[nome]) ||
      limits[nome] <= 0
    ) {
      throw new Error(
        'NCC_SESSION_LIMITI_NON_VALIDI'
      );
    }
  }

  const leaseMs =
    planner.limits?.leaseMs ??
    NCC_PLANNER_LIMITS.leaseMs;

  const margineMs = Math.max(
    1,
    Math.min(
      1000,
      Math.floor(leaseMs * 0.1)
    )
  );

  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    limits.heartbeatMs +
      limits.timeoutRedisMs * 2 +
      margineMs >= leaseMs
  ) {
    throw new Error(
      'NCC_SESSION_LEASE_INCOMPATIBILE'
    );
  }

  const operatoriLocali = new Set();

  async function rilasciaSicuro(lease) {
    try {

      const rilasciato = await conTimeout(
        () => lease.rilascia(),
        limits.timeoutRedisMs
      );

      if (!rilasciato) {
        console.warn(
          '[NCC] Lease non piu posseduto:',
          lease.simulazioneId
        );
      }

      return rilasciato === true;

    } catch (e) {

      console.warn(
        '[NCC] Rilascio lease non confermato:',
        lease.simulazioneId,
        e.message
      );

      return false;
    }
  }

  async function esegui(operatoreId, lavoro, opzioniAcquisizione) {

    if (typeof lavoro !== 'function') {
      throw new Error('NCC_LAVORO_NON_VALIDO');
    }

    const op = String(operatoreId ?? '');

    if (!/^[1-9]\d*$/.test(op)) {
      throw new Error('NCC_OPERATORE_NON_VALIDO');
    }

    if (operatoriLocali.has(op)) {
      return {
        consentito: false,
        motivo: 'OPERATORE_OCCUPATO',
        retryAfterMs: limits.heartbeatMs
      };
    }

    operatoriLocali.add(op);

    let lease;
    let controller;
    let heartbeatTimer;
    let sessionTimer;
    let leaseTimer;
    let rinnovoInCorso = null;
    let chiusa = false;
    let motivoStop = null;
    let rinnovi = 0;
    let finalizzazione = false;
    let acquisizioneScaduta = false;
    let puliziaTardiva = false;

    const inizioAcquisizione = performance.now();

    let inizio = inizioAcquisizione;
    let scadenzaSessione = Infinity;
    let scadenzaLease = Infinity;

    function debug(fase, dati = {}) {
      if (process.env.NCC_SESSION_DEBUG !== '1') {
        return;
      }

      console.log('[NCC SESSION V25]', {
        operatoreId: op,
        token: lease?.simulazioneId,
        trascorsiMs: Math.round(
          performance.now() - inizio
        ),
        residuoLeaseMs: Math.round(
          scadenzaLease - performance.now()
        ),
        fase,
        ...dati
      });
    }

    function interrompi(motivo) {

      if (
        chiusa ||
        !controller ||
        controller.signal.aborted
      ) {
        return;
      }

      motivoStop = motivo;

      clearTimeout(heartbeatTimer);
      clearTimeout(leaseTimer);
      clearTimeout(sessionTimer);

      debug('INTERRUZIONE', { motivo });

      controller.abort(
        erroreSessione(motivo)
      );
    }

    function controllaScadenze() {

      if (!controller || controller.signal.aborted) {
        return;
      }

      const adesso = performance.now();

      if (adesso >= scadenzaSessione) {
        interrompi('NCC_SESSIONE_SCADUTA');
        return;
      }

      if (adesso >= scadenzaLease) {
        interrompi('NCC_LEASE_PERSO');
      }
    }

    function verificaAttiva() {

      controllaScadenze();

      if (
        chiusa ||
        !controller ||
        controller.signal.aborted
      ) {
        throw erroreSessione(
          motivoStop ?? 'NCC_SESSIONE_CHIUSA'
        );
      }
    }

    function aggiornaTimerLease() {

      clearTimeout(leaseTimer);

      leaseTimer = setTimeout(
        () => {
          controllaScadenze();

          if (!controller.signal.aborted) {
            aggiornaTimerLease();
          }
        },
        Math.max(
          1,
          Math.ceil(
            scadenzaLease - performance.now()
          )
        )
      );
    }

    function rinnovaSerializzato() {

      if (rinnovoInCorso) {
        return rinnovoInCorso;
      }

      rinnovoInCorso = (async () => {

        verificaAttiva();

        const partenza = performance.now();

        debug('RINNOVO_INIZIO');

        const valido = await conTimeout(
          () => lease.rinnova(),
          limits.timeoutRedisMs
        );

        verificaAttiva();

        if (!valido) {
          interrompi('NCC_LEASE_PERSO');
          verificaAttiva();
        }

        scadenzaLease =
          partenza + leaseMs - margineMs;

        verificaAttiva();

        aggiornaTimerLease();

        debug('RINNOVO_OK');

        return true;

      })().finally(() => {
        rinnovoInCorso = null;
      });

      return rinnovoInCorso;
    }

    async function heartbeat() {

      if (
        chiusa ||
        finalizzazione ||
        controller.signal.aborted
      ) {
        return;
      }

      try {

        await rinnovaSerializzato();

        rinnovi++;

        if (
          !chiusa &&
          !finalizzazione &&
          !controller.signal.aborted
        ) {
          heartbeatTimer = setTimeout(
            heartbeat,
            limits.heartbeatMs
          );
        }

      } catch (e) {

        debug('HEARTBEAT_ERRORE', {
          errore: e.message
        });

        interrompi('NCC_HEARTBEAT_FALLITO');
      }
    }

    try {

      const acquisizione = Promise.resolve()
        .then(() => planner.acquisisci(op, opzioniAcquisizione))
        .then(async risultato => {

          if (acquisizioneScaduta) {

            try {
              if (risultato?.consentito) {
                await rilasciaSicuro(risultato);
              }
            } finally {
              operatoriLocali.delete(op);
            }
          }

          return risultato;

        }, errore => {

          if (acquisizioneScaduta) {
            operatoriLocali.delete(op);
          }

          throw errore;
        });

      try {

        lease = await conTimeout(
          () => acquisizione,
          limits.timeoutRedisMs
        );

      } catch (e) {

        acquisizioneScaduta = true;
        puliziaTardiva = true;

        // Mantiene il blocco locale finche
        // l'acquisizione pendente non termina.
        acquisizione.then(
          () => operatoriLocali.delete(op),
          () => operatoriLocali.delete(op)
        );

        throw e;
      }

      if (!lease.consentito) {

        return {
          consentito: false,
          motivo: lease.motivo,
          retryAfterMs: lease.retryAfterMs
        };
      }

      controller = new AbortController();

      inizio = performance.now();

      scadenzaSessione =
        inizio + limits.durataMassimaMs;

      scadenzaLease =
        inizioAcquisizione + leaseMs - margineMs;

      verificaAttiva();

      debug('ACQUISITA', {
        leaseMs,
        margineMs
      });

      aggiornaTimerLease();

      let authGeografia = null;

      function ottieniAuthGeografia() {

        verificaAttiva();

        if (!authGeografia) {

          authGeografia =
            creaAutorizzazioneGeografia({

              operatoreId: lease.operatoreId,

              simulazioneId: lease.simulazioneId
            });
        }

        return authGeografia;
      }

      const auth = creaAutorizzazione({
        operatoreId: lease.operatoreId,
        simulazioneId: lease.simulazioneId
      });

      heartbeatTimer = setTimeout(
        heartbeat,
        limits.heartbeatMs
      );

      sessionTimer = setTimeout(
        () => interrompi('NCC_SESSIONE_SCADUTA'),
        limits.durataMassimaMs
      );

      async function autorizzaRouting(n) {

        verificaAttiva();

        debug('AUTH_INIZIO', { elementi: n });

        let risultato;

        try {

          risultato = await conTimeout(
            () => auth.autorizza(n),
            limits.timeoutRedisMs
          );

        } catch (e) {

          interrompi(
            'NCC_AUTORIZZAZIONE_FALLITA'
          );

          throw e;
        }

        verificaAttiva();

        if (
          risultato?.consentito === false &&
          risultato.motivo === 'LEASE_PERSO'
        ) {
          interrompi('NCC_LEASE_PERSO');
        }

        debug('AUTH_ESITO', {
          consentito: risultato?.consentito,
          motivo: risultato?.motivo,
          elementi: risultato?.elementiAutorizzati
        });

        return risultato;
      }

      async function autorizzaGeografia(tipo) {

        verificaAttiva();

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

        debug('GEO_AUTH_INIZIO', { tipo });

        let risultato;

        try {

          risultato = await conTimeout(

            () => {

              verificaAttiva();

              return ottieniAuthGeografia()
                .autorizza(tipo);
            },

            limits.timeoutRedisMs
          );

          verificaAttiva();

          if (
            !risultato ||
            typeof risultato.consentito !==
              'boolean' ||
            risultato.elementiAutorizzati !==
              (risultato.consentito ? 1 : 0)
          ) {

            throw erroreSessione(
              'NCC_GEO_AUTH_NON_VALIDA'
            );
          }

        } catch (e) {

          interrompi(
            'NCC_GEO_AUTORIZZAZIONE_FALLITA'
          );

          throw e;
        }

        if (
          !risultato.consentito &&
          risultato.motivo === 'LEASE_PERSO'
        ) {

          interrompi('NCC_LEASE_PERSO');

          verificaAttiva();
        }

        verificaAttiva();

        debug('GEO_AUTH_ESITO', {

          tipo,

          consentito: risultato.consentito,

          motivo: risultato.motivo,

          elementi:
            risultato.elementiAutorizzati
        });

        return risultato;
      }

      const risultato = await lavoro({

        operatoreId: lease.operatoreId,
        simulazioneId: lease.simulazioneId,

        signal: controller.signal,

        verificaAttiva,
        autorizzaRouting,

        autorizzaGeografia,

        diagnostica: () => ({
          rinnovi,

          durataMs: Math.round(
            performance.now() - inizio
          ),

          leaseResiduoMs: Math.max(
            0,
            Math.floor(
              scadenzaLease - performance.now()
            )
          ),

          interrotta: controller.signal.aborted,
          motivoStop,
          budget: auth.diagnostica(),

          budgetGeografia:
            authGeografia?.diagnostica() ?? null
        })
      });

      verificaAttiva();

      finalizzazione = true;

      clearTimeout(heartbeatTimer);

      if (rinnovoInCorso) {
        await rinnovoInCorso;
      }

      verificaAttiva();

      debug('RINNOVO_FINALE_INIZIO');

      await rinnovaSerializzato();

      verificaAttiva();

      debug('RINNOVO_FINALE_OK');

      return {
        consentito: true,
        simulazioneId: lease.simulazioneId,
        risultato,

        sessione: {
          rinnovi,

          durataMs: Math.round(
            performance.now() - inizio
          ),

          budget: auth.diagnostica(),

          budgetGeografia:
            authGeografia?.diagnostica() ?? null
        }
      };

    } finally {

      chiusa = true;
      finalizzazione = true;

      clearTimeout(heartbeatTimer);
      clearTimeout(sessionTimer);
      clearTimeout(leaseTimer);

      if (
        controller &&
        !controller.signal.aborted
      ) {
        controller.abort(
          erroreSessione('NCC_SESSIONE_CHIUSA')
        );
      }

      if (rinnovoInCorso) {
        try {
          await rinnovoInCorso;
        } catch {
          // Sessione gia chiusa.
        }
      }

      if (lease?.consentito) {
        await rilasciaSicuro(lease);
      }

      if (!puliziaTardiva) {
        operatoriLocali.delete(op);
      }

      debug('CHIUSURA', {
        rinnovi,
        motivoStop
      });
    }
  }

  return { esegui };
}
