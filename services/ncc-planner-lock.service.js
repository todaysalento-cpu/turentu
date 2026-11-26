
import { randomUUID } from 'node:crypto';
import { redisClient } from '../redis.js';

export const NCC_PLANNER_LIMITS = Object.freeze({
  maxGlobali: 3,
  cooldownMs: 30000,
  leaseMs: 180000
});

const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 +
  math.floor(tonumber(t[2]) / 1000)

local token = ARGV[1]
local lease = tonumber(ARGV[2])
local cooldown = tonumber(ARGV[3])
local maxGlobali = tonumber(ARGV[4])

redis.call(
  'ZREMRANGEBYSCORE',
  KEYS[2], '-inf', now
)

if redis.call('EXISTS', KEYS[1]) == 1 then
  return {
    0,
    'OPERATORE_OCCUPATO',
    redis.call('PTTL', KEYS[1])
  }
end

if redis.call('EXISTS', KEYS[3]) == 1 then
  return {
    0,
    'COOLDOWN',
    redis.call('PTTL', KEYS[3])
  }
end

if redis.call('ZCARD', KEYS[2]) >= maxGlobali then
  return {0, 'LIMITE_GLOBALE', 5000}
end

redis.call(
  'SET', KEYS[1], token, 'PX', lease
)

redis.call(
  'ZADD', KEYS[2], now + lease, token
)

redis.call('PEXPIRE', KEYS[2], lease * 2)

if cooldown > 0 then
  redis.call(
    'SET', KEYS[3], token, 'PX', cooldown
  )
end

return {1, 'OK', lease}
`;

const RENEW_LUA = `
local token = ARGV[1]
local lease = tonumber(ARGV[2])

if redis.call('GET', KEYS[1]) ~= token then
  return 0
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 +
  math.floor(tonumber(t[2]) / 1000)

local score = redis.call(
  'ZSCORE', KEYS[2], token
)

if not score or tonumber(score) <= now then
  return 0
end

redis.call('PEXPIRE', KEYS[1], lease)

redis.call(
  'ZADD', KEYS[2], now + lease, token
)

redis.call('PEXPIRE', KEYS[2], lease * 2)

return 1
`;

const RELEASE_LUA = `
local token = ARGV[1]

if redis.call('GET', KEYS[1]) ~= token then
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], token)

return 1
`;

export function creaPlannerLockNcc({
  client = redisClient,
  limits = NCC_PLANNER_LIMITS,
  namespace = 'ncc:planner:v23'
} = {}) {

  for (const nome of [
    'maxGlobali',
    'cooldownMs',
    'leaseMs'
  ]) {
    if (
      !Number.isSafeInteger(limits[nome]) ||
      limits[nome] < 0
    ) {
      throw new Error('NCC_LOCK_LIMITI_NON_VALIDI');
    }
  }

  if (
    limits.maxGlobali < 1 ||
    limits.leaseMs < 1
  ) {
    throw new Error('NCC_LOCK_LIMITI_NON_VALIDI');
  }

  const prefix = namespace + ':{planner}';

  async function esegui(script, keys, args) {

    if (!client?.isReady) {
      throw Object.assign(
        new Error('NCC_REDIS_NON_DISPONIBILE'),
        { status: 503 }
      );
    }

    try {
      return await client.eval(script, {
        keys,
        arguments: args.map(String)
      });

    } catch {
      throw Object.assign(
        new Error('NCC_PLANNER_LOCK_REDIS_ERROR'),
        { status: 503 }
      );
    }
  }

  async function acquisisci(operatoreId) {

    const op = String(operatoreId ?? '');

    if (!/^[1-9]\d*$/.test(op)) {
      throw new Error('NCC_OPERATORE_NON_VALIDO');
    }

    const token = randomUUID();

    const lockKey = `${prefix}:lock:${op}`;
    const activeKey = `${prefix}:active`;
    const cooldownKey = `${prefix}:cooldown:${op}`;

    const result = await esegui(
      ACQUIRE_LUA,
      [lockKey, activeKey, cooldownKey],
      [
        token,
        limits.leaseMs,
        limits.cooldownMs,
        limits.maxGlobali
      ]
    );

    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      ![0, 1].includes(Number(result[0]))
    ) {
      throw Object.assign(
        new Error('NCC_LOCK_RISPOSTA_NON_VALIDA'),
        { status: 503 }
      );
    }

    if (Number(result[0]) !== 1) {
      return {
        consentito: false,
        motivo: String(result[1]),
        retryAfterMs: Math.max(
          0,
          Number(result[2]) || 0
        )
      };
    }

    return {
      consentito: true,
      operatoreId: op,
      simulazioneId: token,

      async rinnova() {
        const r = await esegui(
          RENEW_LUA,
          [lockKey, activeKey],
          [token, limits.leaseMs]
        );

        return Number(r) === 1;
      },

      async rilascia() {
        const r = await esegui(
          RELEASE_LUA,
          [lockKey, activeKey],
          [token]
        );

        return Number(r) === 1;
      }
    };
  }

  return {
    acquisisci,
    limits: { ...limits }
  };
}
