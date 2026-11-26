
import { redisClient } from '../redis.js';

export const NCC_BUDGET_LIMITS = Object.freeze({
  elementiSimulazione: 1000,
  elementiOperatore: 5000,
  elementiGlobali: 30000
});

const giornoLocale = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Rome',
  dateStyle: 'short'
});

const RESERVE_LUA = `
local op = tonumber(redis.call('GET', KEYS[1]) or '0')
local globale = tonumber(redis.call('GET', KEYS[2]) or '0')
local simulazione = tonumber(redis.call('GET', KEYS[3]) or '0')

local n = tonumber(ARGV[1])
local limiteOp = tonumber(ARGV[2])
local limiteGlobale = tonumber(ARGV[3])
local limiteSimulazione = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

if simulazione + n > limiteSimulazione then
  return {0, 'SIMULAZIONE', op, globale, simulazione}
end

if op + n > limiteOp then
  return {0, 'OPERATORE', op, globale, simulazione}
end

if globale + n > limiteGlobale then
  return {0, 'GLOBALE', op, globale, simulazione}
end

op = redis.call('INCRBY', KEYS[1], n)
globale = redis.call('INCRBY', KEYS[2], n)
simulazione = redis.call('INCRBY', KEYS[3], n)

redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('EXPIRE', KEYS[3], ttl)

return {1, 'OK', op, globale, simulazione}
`;

export function creaBudgetRoutingNcc({
  operatoreId,
  simulazioneId,
  client = redisClient,
  limits = NCC_BUDGET_LIMITS,
  namespace = 'ncc:routing:v23'
} = {}) {

  const operatore = String(operatoreId ?? '');
  const simulazione = String(simulazioneId ?? '');

  if (!/^[1-9]\d*$/.test(operatore)) {
    throw new Error('NCC_OPERATORE_NON_VALIDO');
  }

  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(simulazione)) {
    throw new Error('NCC_SIMULAZIONE_NON_VALIDA');
  }

  for (const nome of [
    'elementiSimulazione',
    'elementiOperatore',
    'elementiGlobali'
  ]) {
    if (
      !Number.isSafeInteger(limits[nome]) ||
      limits[nome] <= 0
    ) {
      throw new Error('NCC_LIMITE_NON_VALIDO');
    }
  }

  const prefix = namespace + ':{budget}';

  const stats = {
    elementiPrenotati: 0,
    prenotazioniBudget: 0,
    richiesteRifiutate: 0,
    erroriRedis: 0,
    ultimoRifiuto: null
  };

  async function riservaElementi(n) {

    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error('NCC_ELEMENTI_NON_VALIDI');
    }

    if (!client?.isReady) {
      stats.erroriRedis++;

      throw Object.assign(
        new Error('NCC_REDIS_NON_DISPONIBILE'),
        { status: 503 }
      );
    }

    const giorno = giornoLocale.format(new Date());

    const keys = [
      `${prefix}:daily:${giorno}:op:${operatore}`,
      `${prefix}:daily:${giorno}:global`,
      `${prefix}:sim:${operatore}:${simulazione}`
    ];

    let result;

    try {
      result = await client.eval(RESERVE_LUA, {
        keys,
        arguments: [
          String(n),
          String(limits.elementiOperatore),
          String(limits.elementiGlobali),
          String(limits.elementiSimulazione),
          '259200'
        ]
      });
    } catch {
      stats.erroriRedis++;

      throw Object.assign(
        new Error('NCC_BUDGET_REDIS_ERROR'),
        { status: 503 }
      );
    }

    if (
      !Array.isArray(result) ||
      result.length !== 5
    ) {
      stats.erroriRedis++;

      throw Object.assign(
        new Error('NCC_BUDGET_RISPOSTA_NON_VALIDA'),
        { status: 503 }
      );
    }

    const [
      consentito,
      motivo,
      consumoOperatore,
      consumoGlobale,
      consumoSimulazione
    ] = result;

    if (Number(consentito) !== 1) {
      stats.richiesteRifiutate++;
      stats.ultimoRifiuto = String(motivo);

      return {
        consentito: false,
        motivo: String(motivo)
      };
    }

    stats.elementiPrenotati += n;
    stats.prenotazioniBudget++;

    return {
      consentito: true,
      consumoOperatore: Number(consumoOperatore),
      consumoGlobale: Number(consumoGlobale),
      consumoSimulazione: Number(consumoSimulazione)
    };
  }

  return {
    riservaElementi,

    diagnostica: () => ({
      ...stats,
      limits: { ...limits }
    })
  };
}
