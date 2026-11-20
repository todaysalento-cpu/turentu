
import { classificaRisultato } from './territorial-road-results.service.js';

export const RETRY_CONFIG = Object.freeze({
  maxTentativi: 3,
  timeoutMs: 10000,
  ritardoBaseMs: 200,
  ritardoMassimoMs: 2000,
  sogliaSecondi: 900
});

const ERRORI_TEMPORANEI = new Set([
  'TIMEOUT_ROUTING',
  'NETWORK_ERROR',
  'RATE_LIMIT',
  'PROVIDER_UNAVAILABLE'
]);

function attendi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ErroreRouting extends Error {
  constructor(codice, messaggio = codice) {
    super(messaggio);
    this.name = 'ErroreRouting';
    this.codice = codice;
  }
}

export function classificaErrore(error) {
  const codice = error?.codice || error?.code || 'UNKNOWN_ERROR';

  return {
    codice,
    recuperabile: ERRORI_TEMPORANEI.has(codice)
  };
}

export async function eseguiRoutingConRetry({
  routing,
  maxTentativi = RETRY_CONFIG.maxTentativi,
  timeoutMs = RETRY_CONFIG.timeoutMs,
  ritardoBaseMs = RETRY_CONFIG.ritardoBaseMs
}) {
  if (typeof routing !== 'function') {
    throw new Error('Funzione routing obbligatoria');
  }

  if (!Number.isInteger(maxTentativi) ||
      maxTentativi < 1 ||
      maxTentativi > 3) {
    throw new Error('Numero tentativi non valido');
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 10000) {
    throw new Error('Timeout non valido');
  }

  if (!Number.isInteger(ritardoBaseMs) ||
      ritardoBaseMs < 0 ||
      ritardoBaseMs > 2000) {
    throw new Error('Ritardo retry non valido');
  }

  const storico = [];

  for (let tentativo = 1; tentativo <= maxTentativi; tentativo++) {
    const controller = new AbortController();
    let timer;

    try {
      const risposta = await Promise.race([
        Promise.resolve().then(() =>
          routing({
            tentativo,
            signal: controller.signal
          })
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ErroreRouting('TIMEOUT_ROUTING'));
          }, timeoutMs);
        })
      ]);

      const risultato = classificaRisultato(risposta);

      storico.push({
        tentativo,
        esito: 'successo',
        stato: risultato.stato
      });

      return {
        successo: true,
        tentativi: tentativo,
        risultato,
        storico
      };

    } catch (error) {
      const classificazione = classificaErrore(error);

      storico.push({
        tentativo,
        esito: 'errore',
        ...classificazione
      });

      if (
        !classificazione.recuperabile ||
        tentativo === maxTentativi
      ) {
        return {
          successo: false,
          tentativi: tentativo,
          errore: classificazione,
          storico
        };
      }

      const ritardo = Math.min(
        ritardoBaseMs * (2 ** (tentativo - 1)),
        RETRY_CONFIG.ritardoMassimoMs
      );

      await attendi(ritardo);

    } finally {
      clearTimeout(timer);
    }
  }
}
