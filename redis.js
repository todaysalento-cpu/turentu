// ======================= redis.js =======================
import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: retries => {
      console.warn(`⚠️ Tentativo di riconnessione Redis #${retries}`);
      return Math.min(retries * 100, 3000); // backoff esponenziale fino a 3s
    }
  }
});

// =======================
// EVENTI REDIS
// =======================
redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log('🟢 Redis connesso'));
redisClient.on('ready', () => console.log('🚀 Redis pronto'));
redisClient.on('end', () => console.log('🔴 Redis disconnesso'));
redisClient.on('reconnecting', (delay, attempt) => 
  console.log(`🔄 Redis riconnessione in corso... attempt #${attempt}, delay ${delay}ms`)
);

// =======================
// CONNECT
// =======================
(async () => {
  try {
    await redisClient.connect();
    console.log('✅ Redis client connesso correttamente');
    
    // Ping periodico per mantenere la connessione attiva
    setInterval(async () => {
      try {
        await redisClient.ping();
      } catch (err) {
        console.warn('⚠️ Redis ping fallito:', err.message);
      }
    }, 60000); // ogni 60s
  } catch (err) {
    console.error('❌ Impossibile connettersi a Redis:', err);
  }
})();

export { redisClient };