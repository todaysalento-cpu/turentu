import fetch from 'node-fetch';
import { redisClient } from '../../redis.js';

const ENDPOINT =
  'https://maps.googleapis.com/maps/api/distancematrix/json';

const BATCH_SIZE = 25;
const TIMEOUT_MS = 12000;

function normalize(value) {
  if (
    value?.lat == null ||
    (value?.lng ?? value?.lon) == null ||
    String(value.lat).trim() === '' ||
    String(value.lng ?? value.lon).trim() === ''
  ) return null;

  const lat = Number(value.lat);
  const lng = Number(value.lng ?? value.lon);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0)
  ) return null;

  return { lat, lng };
}

function coordKey(c) {
  return `${c.lat},${c.lng}`;
}

async function reserveBudget(userId, elements) {
  if (!redisClient?.isReady) {
    throw new Error('EVENT_ROUTING_REDIS_UNAVAILABLE');
  }

  const dailyLimit = Number(
    process.env.EVENT_ROUTING_DAILY_LIMIT ?? 2000
  );

  const userLimit = Number(
    process.env.EVENT_ROUTING_USER_LIMIT ?? 6
  );

  if (
    !Number.isSafeInteger(dailyLimit) ||
    dailyLimit < 1 ||
    !Number.isSafeInteger(userLimit) ||
    userLimit < 1
  ) {
    throw new Error('EVENT_ROUTING_INVALID_CONFIG');
  }

  const day = new Date().toISOString().slice(0, 10);
  const minute = Math.floor(Date.now() / 60000);

  const result = await redisClient.eval(`
    local daily = tonumber(redis.call('GET', KEYS[1]) or '0')
    local user = tonumber(redis.call('GET', KEYS[2]) or '0')

    if daily + tonumber(ARGV[1]) > tonumber(ARGV[2]) then
      return 0
    end

    if user >= tonumber(ARGV[3]) then
      return 0
    end

    redis.call('INCRBY', KEYS[1], ARGV[1])
    redis.call('EXPIRE', KEYS[1], 172800)

    redis.call('INCR', KEYS[2])
    redis.call('EXPIRE', KEYS[2], 120)

    return 1
  `, {
    keys: [
      `event-routing:daily:${day}`,
      `event-routing:user:${userId}:${minute}`,
    ],
    arguments: [
      String(elements),
      String(dailyLimit),
      String(userLimit),
    ],
  });

  if (Number(result) !== 1) {
    throw new Error('EVENT_ROUTING_LIMIT_REACHED');
  }
}

export async function getEventRoadDistances(
  origine,
  destinazioni,
  userId
) {
  const origin = normalize(origine);

  if (
    !origin ||
    !Array.isArray(destinazioni) ||
    destinazioni.length < 1 ||
    destinazioni.length > BATCH_SIZE ||
    userId == null
  ) {
    throw new Error('EVENT_ROUTING_INVALID_INPUT');
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error('EVENT_ROUTING_API_KEY_MISSING');
  }

  const unique = new Map();

  const entries = destinazioni.map(item => {
    const coord = normalize(item);
    const key = coord ? coordKey(coord) : null;

    if (key) unique.set(key, coord);

    return { id: item?.id ?? null, key };
  });

  const keys = [...unique.keys()];
  const distances = new Map();

  if (keys.length > 0) {
    await reserveBudget(userId, keys.length);

    const url = new URL(ENDPOINT);

    url.searchParams.set('origins', coordKey(origin));
    url.searchParams.set('destinations', keys.join('|'));
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('units', 'metric');
    url.searchParams.set('key', apiKey);

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      TIMEOUT_MS
    );

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error('EVENT_ROUTING_GOOGLE_ERROR');
      }

      const data = await response.json();

      if (data.status !== 'OK') {
        throw new Error('EVENT_ROUTING_GOOGLE_ERROR');
      }

      const elements = data.rows?.[0]?.elements ?? [];

      keys.forEach((key, index) => {
        const element = elements[index];

        if (
          element?.status === 'OK' &&
          Number.isFinite(element.distance?.value) &&
          element.distance.value >= 0 &&
          Number.isFinite(element.duration?.value) &&
          element.duration.value >= 0
        ) {
          distances.set(key, {
            distanzaKm: element.distance.value / 1000,
            durataMs: element.duration.value * 1000,
          });
        }
      });
    } catch {
      throw new Error('EVENT_ROUTING_GOOGLE_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  return entries.map(entry => ({
    id: entry.id,
    distanzaKm:
      distances.get(entry.key)?.distanzaKm ?? null,
    durataMs:
      distances.get(entry.key)?.durataMs ?? null,
  }));
}