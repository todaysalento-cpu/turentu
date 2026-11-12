import { pool } from '../../db/db.js';

let running = false;
let timer;

export function parseCloudinaryUrl(value, cloudName) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' ||
        !cloudName || parts[0] !== cloudName ||
        !['image', 'video', 'raw'].includes(parts[1]) || parts[2] !== 'upload') return null;
    const version = parts.findIndex((part, index) => index >= 3 && /^v\d+$/.test(part));
    if (version < 3 || version >= parts.length - 1) return null;
    let publicId = decodeURIComponent(parts.slice(version + 1).join('/'));
    if (parts[1] !== 'raw') publicId = publicId.replace(/\.[^/.]+$/, '');
    if (!publicId || publicId.split('/').some(part => part === '..')) return null;
    return { publicId, resourceType: parts[1] };
  } catch {
    return null;
  }
}

async function removeResource(job) {
  if (job.tipo !== 'file') {
    const { CacheManager } = await import('../../utils/cacheManager.js');
    await CacheManager[job.tipo].delete(job.risorsa_id);
    return 'eliminato';
  }
  const resource = parseCloudinaryUrl(job.url, process.env.CLOUDINARY_CLOUD_NAME);
  if (!resource) return 'manuale';
  // Un file ancora usato da un altro account conserva il proprio ciclo di vita.
  const { rows: [shared] } = await pool.query(`
    SELECT EXISTS (SELECT 1 FROM documenti_autista WHERE url = $1)
      OR EXISTS (SELECT 1 FROM autista_profilo WHERE foto_profilo = $1 OR documenti::text LIKE '%' || $1 || '%')
      OR EXISTS (SELECT 1 FROM veicolo WHERE image_url = $1)
      OR EXISTS (SELECT 1 FROM messaggi WHERE audio_url = $1 OR media_url = $1) AS in_use
  `, [job.url]);
  if (shared.in_use) return 'manuale';
  const { cloudinary } = await import('../cloudinary.js');
  const result = await cloudinary.uploader.destroy(resource.publicId, {
    resource_type: resource.resourceType, invalidate: true, timeout: 15000,
  });
  if (!['ok', 'not found'].includes(result.result)) throw new Error('FILE_DELETE_FAILED');
  return 'eliminato';
}

export async function processAccountRemovals(limit = 10) {
  if (running) return;
  running = true;
  try {
    for (let index = 0; index < limit; index++) {
      const { rows: [job] } = await pool.query(`
        WITH candidate AS (
          SELECT id FROM admin_rimozioni_file_utenti
          WHERE stato IN ('pending', 'processing') AND prossimo_tentativo_il <= now()
          ORDER BY CASE WHEN tipo = 'file' THEN 1 ELSE 0 END, id
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE admin_rimozioni_file_utenti q SET stato = 'processing',
          tentativi = tentativi + 1, prossimo_tentativo_il = now() + interval '2 minutes',
          aggiornato_il = now()
        FROM candidate c WHERE q.id = c.id RETURNING q.*
      `);
      if (!job) break;
      try {
        const status = await removeResource(job);
        await pool.query(`
          UPDATE admin_rimozioni_file_utenti SET stato = $2,
            url = CASE WHEN $2 = 'eliminato' THEN NULL ELSE url END, aggiornato_il = now()
          WHERE id = $1 AND tentativi = $3
        `, [job.id, status, job.tentativi]);
      } catch {
        await pool.query(`
          UPDATE admin_rimozioni_file_utenti SET stato = 'pending',
            prossimo_tentativo_il = now() + least(tentativi, 60) * interval '1 minute',
            aggiornato_il = now() WHERE id = $1 AND tentativi = $2
        `, [job.id, job.tentativi]);
      }
    }
  } finally {
    running = false;
  }
}

export function startAccountRemovals() {
  if (timer) return;
  const run = () => processAccountRemovals().catch(error =>
    console.error('Pulizia account:', error.code || error.name));
  timer = setInterval(run, 30000);
  timer.unref();
  void run();
}
