import { createEventImageNetwork } from "./event-image-network.service.js";
import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { pool } from '../../db/db.js';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT = 15000;

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

function isPublicIP(address) {
  try {
    const ip = ipaddr.process(address);

    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}

const network = createEventImageNetwork();

async function downloadImage(url, domain) {
  const parsed = new URL(url);

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== domain ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error('URL immagine non consentito');
  }

  const resolver = new dns.Resolver({ timeout: 5000, tries: 1 });
  const addresses = await resolver.resolve4(parsed.hostname);

  if (
    !addresses.length ||
    addresses.some(ip => !isPublicIP(ip))
  ) {
    throw new Error('Indirizzo IP non consentito');
  }

  const address = addresses[0];

  return new Promise((resolve, reject) => {
    const req = https.get(parsed, {
      family: 4,
      agent: false,

      lookup: (hostname, options, callback) => {
        if (options.all) {
          callback(null, [
            { address, family: 4 }
          ]);
        } else {
          callback(null, address, 4);
        }
      },

      headers: {
        'User-Agent': 'Turentu-EventImages/1.0',
        'Accept': 'image/jpeg,image/png,image/webp',
        'Accept-Encoding': 'identity'
      }

    }, res => {
      if (res.statusCode !== 200) {
        res.destroy();

        reject(
          new Error(`HTTP ${res.statusCode}`)
        );

        return;
      }

      const type = String(
        res.headers['content-type'] || ''
      ).split(';')[0].trim().toLowerCase();

      if (!ALLOWED_TYPES.has(type)) {
        res.destroy();
        reject(new Error('Formato non consentito'));
        return;
      }

      const length = Number(
        res.headers['content-length'] || 0
      );

      if (length > MAX_BYTES) {
        res.destroy();
        reject(new Error('Immagine troppo grande'));
        return;
      }

      const chunks = [];
      let bytes = 0;

      res.on('data', chunk => {
        bytes += chunk.length;

        if (bytes > MAX_BYTES) {
          req.destroy(
            new Error('Limite dimensione superato')
          );

          return;
        }

        chunks.push(chunk);
      });

      res.on('error', reject);

      res.on('aborted', () => {
        reject(new Error('Download interrotto'));
      });

      res.on('end', () => {
        if (!bytes) {
          reject(new Error('Immagine vuota'));
          return;
        }

        resolve(Buffer.concat(chunks));
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error('Timeout download'));
    }, TIMEOUT);

    req.on('error', reject);

    req.on('close', () => {
      clearTimeout(timer);
    });
  });
}

export async function downloadCandidateImage(
  candidateId
) {
  const { rows } = await pool.query(`
    SELECT
      c.*,
      s.dominio,
      s.download_abilitato,
      s.licenza AS licenza_fonte,
      s.verificato_il
    FROM public.event_image_candidates c
    JOIN public.event_image_sources s
      ON s.id = c.source_id
    WHERE c.id = $1
  `, [candidateId]);

  if (!rows.length) {
    throw new Error('Candidata non trovata');
  }

  const candidate = rows[0];

  if (
    !candidate.download_abilitato ||
    !candidate.licenza_fonte?.trim() ||
    !candidate.verificato_il
  ) {
    throw new Error(
      'Fonte non autorizzata al download'
    );
  }

  if (
    candidate.stato !== 'approved' ||
    !candidate.diritti_verificati ||
    !candidate.licenza?.trim()
  ) {
    throw new Error(
      'Candidata non autorizzata'
    );
  }

  await network.checkImageAccess(candidate.immagine_originale_url, "Turentu-EventImages/1.0");

  return downloadImage(
    candidate.immagine_originale_url,
    candidate.dominio
  );
}