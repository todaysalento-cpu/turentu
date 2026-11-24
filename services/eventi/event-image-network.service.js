import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import robotsParser from 'robots-parser';

const USER_AGENT = 'Turentu-EventImageDiscovery/1.0';

const MAX_HTML = 2 * 1024 * 1024;
const TIMEOUT = 12000;

const ALLOWED_DOMAINS = new Set([
  'www.pugliaculture.it'
]);

function validateUrl(value) {
  const url = new URL(value);

  if (
    url.protocol !== 'https:' ||
    !ALLOWED_DOMAINS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('URL non consentito');
  }

  return url;
}

function isPublicIP(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

async function resolvePublicIP(hostname) {
  let timer;

  try {
    const addresses = await Promise.race([
      dns.resolve4(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timeout DNS')),
          5000
        );
      })
    ]);

    if (
      !addresses.length ||
      addresses.some(address => !isPublicIP(address))
    ) {
      throw new Error('Indirizzo IP non consentito');
    }

    return addresses[0];

  } finally {
    clearTimeout(timer);
  }
}

async function readText(value, robots = false) {
  const url = validateUrl(value);
  const address = await resolvePublicIP(url.hostname);

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: false,
      family: 4,

      lookup: (hostname, options, callback) => {
        if (options?.all) {
          callback(null, [
            { address, family: 4 }
          ]);
        } else {
          callback(null, address, 4);
        }
      },

      headers: {
        'User-Agent': USER_AGENT,
        'Accept': robots ? 'text/plain' : 'text/html',
        'Accept-Encoding': 'identity'
      }

    }, res => {
      if (robots && res.statusCode === 404) {
        res.resume();
        resolve('');
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const contentType = String(
        res.headers['content-type'] || ''
      ).toLowerCase();

      const validType = robots
        ? contentType.includes('text/plain')
        : contentType.includes('text/html');

      if (!validType) {
        res.resume();
        reject(new Error('Contenuto non consentito'));
        return;
      }

      const limit = robots
        ? 512 * 1024
        : MAX_HTML;

      const chunks = [];
      let size = 0;

      res.on('data', chunk => {
        size += chunk.length;

        if (size > limit) {
          req.destroy(
            new Error('Risposta troppo grande')
          );
          return;
        }

        chunks.push(chunk);
      });

      res.on('aborted', () => {
        reject(new Error('Risposta interrotta'));
      });

      res.on('error', reject);

      res.on('end', () => {
        resolve(
          Buffer.concat(chunks).toString('utf8')
        );
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error('Timeout richiesta'));
    }, TIMEOUT);

    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
  });
}

export function createEventImageNetwork() {
  const robotsCache = new Map();
  const pageCache = new Map();
  const lastRequest = new Map();

  async function throttle(hostname, delay = 2000) {
    const elapsed =
      Date.now() - (lastRequest.get(hostname) || 0);

    const wait = Math.max(0, delay - elapsed);

    if (wait) {
      await new Promise(resolve =>
        setTimeout(resolve, wait)
      );
    }

    lastRequest.set(hostname, Date.now());
  }

  async function getRobots(url) {
    const origin = url.origin;

    if (!robotsCache.has(origin)) {
      const robotsUrl = origin + '/robots.txt';

      await throttle(url.hostname);

      const text = await readText(
        robotsUrl,
        true
      );

      robotsCache.set(
        origin,
        robotsParser(robotsUrl, text)
      );
    }

    return robotsCache.get(origin);
  }

  async function readPage(value) {
    const url = validateUrl(value);
    url.hash = '';

    const key = url.href;

    if (pageCache.has(key)) {
      return pageCache.get(key);
    }

    const robots = await getRobots(url);

    if (robots.isAllowed(key, USER_AGENT) !== true) {
      throw new Error('Pagina non consentita da robots.txt');
    }

    const crawlDelay = Number(
      robots.getCrawlDelay(USER_AGENT) || 0
    );

    if (crawlDelay > 60) {
      throw new Error('Crawl-delay superiore al limite operativo');
    }

    await throttle(
      url.hostname,
      Math.max(2000, crawlDelay * 1000)
    );

    const html = await readText(key);

    pageCache.set(key, html);

    return html;
  }

  async function checkImageAccess(value, userAgent = USER_AGENT) {
    const url = validateUrl(value);
    const robots = await getRobots(url);
    if (robots.isAllowed(url.href, userAgent) !== true) throw new Error("Immagine non consentita da robots.txt");
    const delay = Number(robots.getCrawlDelay(userAgent) || 0);
    if (delay > 60) throw new Error("Crawl-delay superiore al limite operativo");
    await throttle(url.hostname, Math.max(2000, delay * 1000));
  }

  return {
    readPage,
    checkImageAccess
  };
}