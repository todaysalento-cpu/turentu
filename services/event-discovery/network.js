import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { isAndiamoPugliaFeed } from './andiamo-puglia.js';

export function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('URL non valido');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !url.hostname.includes('.') || url.hostname.endsWith('.') || isIP(url.hostname) ||
      /\.(local|localhost|internal|test|invalid|onion|lan)$/.test(url.hostname)) {
    throw new Error('URL non consentito');
  }
  url.hash = '';
  return url;
}

function globalIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a > 0 && a < 224 && ![10, 127].includes(a) &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 88, 168].includes(b)) &&
    !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0 && c === 113);
}

async function once(url, headers, signal) {
  const byteLimit = isAndiamoPugliaFeed(url) ? 4_000_000 : 2_000_000;
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  const addresses = (await resolver.resolve4(url.hostname)).map((address) => ({ address, family: 4 }));
  if (!addresses.length || addresses.some(({ address }) => !globalIPv4(address))) {
    throw new Error('Indirizzo della fonte non consentito');
  }
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, family: 4, signal, headers: { 'User-Agent': 'TurentuEventDiscovery/1.0', ...headers },
      lookup: (_host, options, callback) => options.all
        ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > byteLimit) req.destroy(new Error('Risposta troppo grande'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function readRemote(value, headers = {}, fetchOnce = once, wait = delay) {
  const url = publicUrl(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchOnce(url, headers, AbortSignal.timeout(8000)).catch((error) => {
      if (!['ABORT_ERR', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error.code) || attempt === 2) throw error;
      return { status: 503, headers: {} };
    });
    if (result.status === 200 || result.status === 304) return result;
    if (result.status === 429 || result.status < 500 || attempt === 2) {
      const error = new Error(`HTTP ${result.status}`);
      error.status = result.status;
      throw error;
    }
    await wait(500 * 2 ** attempt);
  }
}

export async function readSource(source, read = readRemote) {
  const url = publicUrl(source.url);
  // Conservatively honor every disallow rule, regardless of user-agent group.
  const robots = await read(new URL('/robots.txt', url).href).catch((error) => {
    if (error.status === 404 || error.status === 410) return { body: '' };
    throw error;
  });
  const blocked = robots.body.split(/\r?\n/).some((line) => {
    const rule = /^\s*disallow\s*:\s*([^#]*)/i.exec(line)?.[1].trim();
    if (!rule) return false;
    if (rule.length > 2048) return true;
    const prefix = rule.split('*', 1)[0].replace(/\$$/, '');
    return (url.pathname + url.search).startsWith(prefix);
  });
  if (blocked) throw new Error('Acquisizione esclusa da robots.txt');
  return read(url.href, source.etag ? { 'If-None-Match': source.etag } : {});
}
