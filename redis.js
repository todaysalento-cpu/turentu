// ======================= redis.js =======================
// Redis 5.12.1 - connessione gestita esplicitamente dal bootstrap.
import { createClient } from 'redis';

const redisUrl = process.env.NCC_TEST_ROLLBACK_ONLY === '1'
  ? null
  : process.env.REDIS_URL;

if (!redisUrl) {
  console.warn('⚠️ REDIS_URL non impostato, Redis disabilitato');
}

const redisClient = redisUrl
  ? createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: retries => {
          // Evita che il bootstrap rimanga bloccato indefinitamente.
          if (retries > 8) {
            return new Error('Redis non raggiungibile dopo 8 tentativi di riconnessione');
          }
          const delay = Math.min(retries * 100, 3000);
          console.warn(`⚠️ Tentativo di riconnessione Redis #${retries}, attesa ${delay}ms`);
          return delay;
        },
      },
    })
  : null;

if (redisClient) {
  redisClient.on('error', err => console.error('❌ Redis Client Error:', err));
  redisClient.on('connect', () => console.log('🟢 Redis connesso'));
  redisClient.on('ready', () => console.log('🚀 Redis pronto'));
  redisClient.on('end', () => console.log('🔴 Redis disconnesso'));
  redisClient.on('reconnecting', () => console.log('🔄 Redis riconnessione in corso...'));
}

let redisConnectPromise = null;

// Usare questa funzione nel bootstrap di server.js prima di avviare HTTP.
// Più chiamanti simultanei attendono la stessa connessione.
export async function ensureRedisReady() {
  if (!redisClient) {
    throw new Error('REDIS_NOT_CONFIGURED');
  }

  if (redisClient.isReady) return redisClient;

  if (!redisConnectPromise) {
    if (redisClient.isOpen) {
      // Redis 5 può avere il socket aperto mentre sta completando il readiness.
      // In condizioni normali questa situazione non si presenta al primo avvio,
      // perché la connessione viene avviata soltanto qui.
      throw new Error('REDIS_OPEN_NOT_READY');
    }

    const pending = redisClient.connect().then(() => {
      if (!redisClient.isReady) throw new Error('REDIS_NOT_READY');
      return redisClient;
    });
    redisConnectPromise = pending;
    void pending.finally(() => {
      if (redisConnectPromise === pending) redisConnectPromise = null;
    }).catch(() => {});
  }

  return redisConnectPromise;
}

// Compatibilità con tutti gli import esistenti.
export { redisClient };
