
import { redisClient } from '../redis.js';

import {
  NCC_BUDGET_LIMITS
} from './ncc-routing-budget.service.js';

const giornoLocale = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Rome',
  dateStyle: 'short'
});

const AUTHORIZE_LUA = `
local token = ARGV[1]
local richiesti = tonumber(ARGV[2])
local limiteOp = tonumber(ARGV[3])
local limiteGlobale = tonumber(ARGV[4])
local limiteSim = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

-- Verifica proprietario del lease.

if redis.call('GET', KEYS[1]) ~= token then
  return {0, 'LEASE_PERSO', 0, 0, 0, 0}
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 +
  math.floor(tonumber(t[2]) / 1000)

local score = redis.call(
  'ZSCORE', KEYS[2], token
)

if not score or tonumber(score) <= now then
  return {0, 'LEASE_PERSO', 0, 0, 0, 0}
end

-- Lettura contatori.

local op = tonumber(
  redis.call('GET', KEYS[3]) or '0'
)

local globale = tonumber(
  redis.call('GET', KEYS[4]) or '0'
)

local sim = tonumber(
  redis.call('GET', KEYS[5]) or '0'
)

local residuoOp = limiteOp - op
local residuoGlobale = limiteGlobale - globale
local residuoSim = limiteSim - sim

-- Autorizzazione anche parziale.

local n = math.min(
  richiesti,
  residuoOp,
  residuoGlobale,
  residuoSim
)

if n <= 0 then
  local motivo = 'GLOBALE'

  if residuoSim <= 0 then
    motivo = 'SIMULAZIONE'
  elseif residuoOp <= 0 then
    motivo = 'OPERATORE'
  end

  return {0, motivo, 0, op, globale, sim}
end

op = redis.call('INCRBY', KEYS[3], n)
globale = redis.call('INCRBY', KEYS[4], n)
sim = redis.call('INCRBY', KEYS[5], n)

redis.call('EXPIRE', KEYS[3], ttl)
redis.call('EXPIRE', KEYS[4], ttl)
redis.call('EXPIRE', KEYS[5], ttl)

local motivo = 'OK'

if n < richiesti then
  motivo = 'PARZIALE'
end

return {1, motivo, n, op, globale, sim}
`;

export function creaAutorizzazioneRoutingNcc({
  operatoreId,
  simulazioneId,
  client = redisClient,
  limits = NCC_BUDGET_LIMITS,
  plannerNamespace = 'ncc:planner:v23',
  budgetNamespace = 'ncc:routing:v24'
} = {}) {

  const op = String(operatoreId ?? '');
  const token = String(simulazioneId ?? '');

  if (!/^[1-9]\d*$/.test(op)) {
    throw new Error('NCC_OPERATORE_NON_VALIDO');
  }

  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(token)) {
    throw new Error('NCC_TOKEN_NON_VALIDO');
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

  // Stesso hash tag del Planner Lock esistente.
  const planner = plannerNamespace + ':{planner}';
  const budget = budgetNamespace + ':{planner}';

  const stats = {
    richieste: 0,
    elementiRichiesti: 0,
    elementiAutorizzati: 0,
    autorizzazioniParziali: 0,
    rifiuti: 0,
    leasePersi: 0,
    erroriRedis: 0
  };

  async function autorizza(n) {

    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error('NCC_ELEMENTI_NON_VALIDI');
    }

    stats.richieste++;
    stats.elementiRichiesti += n;

    if (!client?.isReady) {
      stats.erroriRedis++;

      throw Object.assign(
        new Error('NCC_REDIS_NON_DISPONIBILE'),
        { status: 503 }
      );
    }

    const giorno = giornoLocale.format(new Date());

    const keys = [
      `${planner}:lock:${op}`,
      `${planner}:active`,
      `${budget}:daily:${giorno}:op:${op}`,
      `${budget}:daily:${giorno}:global`,
      `${budget}:sim:${op}:${token}`
    ];

    let result;

    try {
      result = await client.eval(AUTHORIZE_LUA, {
        keys,
        arguments: [
          token,
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
        new Error('NCC_AUTH_REDIS_ERROR'),
        { status: 503 }
      );
    }

    if (
      !Array.isArray(result) ||
      result.length !== 6 ||
      ![0, 1].includes(Number(result[0]))
    ) {
      stats.erroriRedis++;

      throw Object.assign(
        new Error('NCC_AUTH_RISPOSTA_NON_VALIDA'),
        { status: 503 }
      );
    }

    const [
      consentito,
      motivo,
      elementi,
      consumoOperatore,
      consumoGlobale,
      consumoSimulazione
    ] = result;

    const autorizzati = Number(elementi);

    if (
      !Number.isSafeInteger(autorizzati) ||
      autorizzati < 0 ||
      autorizzati > n ||
      (Number(consentito) === 1 && autorizzati === 0) ||
      (Number(consentito) === 0 && autorizzati !== 0)
    ) {
      throw new Error('NCC_AUTH_ELEMENTI_NON_VALIDI');
    }

    if (Number(consentito) !== 1) {
      stats.rifiuti++;

      if (motivo === 'LEASE_PERSO') {
        stats.leasePersi++;
      }

      return {
        consentito: false,
        motivo: String(motivo),
        elementiAutorizzati: 0
      };
    }

    stats.elementiAutorizzati += autorizzati;

    if (autorizzati < n) {
      stats.autorizzazioniParziali++;
    }

    return {
      consentito: true,
      motivo: String(motivo),
      elementiAutorizzati: autorizzati,
      consumoOperatore: Number(consumoOperatore),
      consumoGlobale: Number(consumoGlobale),
      consumoSimulazione: Number(consumoSimulazione)
    };
  }

  return {
    autorizza,

    diagnostica: () => ({
      ...stats,
      limits: { ...limits }
    })
  };
}
