
import { pool } from '../db/db.js';

import {
  downloadCandidateImage,
} from '../services/eventi/event-image-download.service.js';

import {
  publishEventImage,
} from '../services/eventi/event-image-publication.service.js';

const INTERVAL_MS = 10000;
const LOCK_KEY = 274028;

let timer = null;
let running = false;

async function updateJob(client, jobId) {
  await client.query(`
    WITH counts AS (
      SELECT
        COUNT(*) AS totale,
        COUNT(*) FILTER (
          WHERE stato IN ('pending', 'running')
        ) AS attive,
        COUNT(*) FILTER (
          WHERE stato = 'published'
        ) AS pubblicate,
        COUNT(*) FILTER (
          WHERE stato = 'error'
        ) AS errori
      FROM public.event_image_publication_items
      WHERE job_id = $1
    )
    UPDATE public.event_image_publication_jobs j
    SET stato = CASE
          WHEN counts.attive > 0 THEN 'running'
          WHEN counts.pubblicate = counts.totale
            THEN 'completed'
          WHEN counts.errori = counts.totale
            THEN 'error'
          ELSE 'partial'
        END,
        finished_at = CASE
          WHEN counts.attive = 0 THEN NOW()
          ELSE NULL
        END
    FROM counts
    WHERE j.id = $1
  `, [jobId]);
}

async function finishItem(
  client,
  item,
  stato,
  errore = null
) {
  await client.query(`
    UPDATE public.event_image_publication_items
    SET stato = $2,
        errore = $3,
        finished_at = NOW()
    WHERE id = $1
  `, [item.id, stato, errore]);

  await updateJob(client, item.job_id);
}

async function recoverInterrupted(client) {
  await client.query(`
    UPDATE public.event_image_publication_items
    SET stato = 'pending',
        started_at = NULL
    WHERE stato = 'running'
  `);
}

async function processItem(client, item) {
  const result = await client.query(`
    SELECT
      c.stato,
      c.diritti_verificati,
      c.licenza,
      e.stato AS stato_evento,
      e.immagine_url
    FROM public.event_image_candidates c
    JOIN public.eventi e
      ON e.id = c.evento_id
    WHERE c.id = $1
  `, [item.candidate_id]);

  const candidate = result.rows[0];

  if (!candidate) {
    return finishItem(
      client, item, 'error',
      'Candidata non trovata'
    );
  }

  if (candidate.stato === 'published') {
    return finishItem(client, item, 'published');
  }

  if (
    candidate.stato_evento !== 'approvato' ||
    String(candidate.immagine_url || '').trim()
  ) {
    return finishItem(
      client, item, 'skipped',
      'Evento non pubblicabile o copertina gia presente'
    );
  }

  if (
    candidate.stato !== 'approved' ||
    !candidate.diritti_verificati ||
    !candidate.licenza
  ) {
    return finishItem(
      client, item, 'error',
      'Approvazione o diritti mancanti'
    );
  }

  try {
    const buffer = await downloadCandidateImage(
      item.candidate_id
    );

    await publishEventImage(
      item.candidate_id,
      buffer
    );

    await finishItem(client, item, 'published');

    console.log(
      '[EVENT IMAGE WORKER] Pubblicata:',
      item.candidate_id
    );
  } catch (error) {
    await finishItem(
      client,
      item,
      'error',
      String(error.message || error).slice(0, 1000)
    );

    console.error(
      '[EVENT IMAGE WORKER]',
      item.candidate_id,
      error.message
    );
  }
}

export async function runPublicationQueue() {
  if (running) return;

  if (
    process.env.EVENT_IMAGE_REMOTE_PUBLISH_ENABLED
      !== 'true'
  ) return;

  running = true;

  let client;
  let locked = false;

  try {
    client = await pool.connect();

    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_KEY]
    );

    locked = lock.rows[0].locked;

    if (!locked) return;

    await recoverInterrupted(client);

    const result = await client.query(`
      SELECT i.*
      FROM public.event_image_publication_items i
      JOIN public.event_image_publication_jobs j
        ON j.id = i.job_id
      WHERE i.stato = 'pending'
        AND j.stato IN ('pending', 'running')
      ORDER BY j.id, i.id
      LIMIT 10
    `);

    for (const item of result.rows) {
      if (
        process.env.EVENT_IMAGE_REMOTE_PUBLISH_ENABLED
          !== 'true'
      ) break;

      await client.query(`
        UPDATE public.event_image_publication_jobs
        SET stato = 'running',
            started_at = COALESCE(started_at, NOW())
        WHERE id = $1
      `, [item.job_id]);

      await client.query(`
        UPDATE public.event_image_publication_items
        SET stato = 'running',
            tentativi = tentativi + 1,
            started_at = NOW()
        WHERE id = $1
      `, [item.id]);

      await processItem(client, item);
    }

    const unfinished = await client.query(`
      SELECT id
      FROM public.event_image_publication_jobs
      WHERE stato = 'running'
    `);

    for (const job of unfinished.rows) {
      await updateJob(client, job.id);
    }

  } catch (error) {
    console.error(
      '[EVENT IMAGE WORKER]',
      error.message
    );
  } finally {
    try {
      if (client && locked) {
        await client.query(
          'SELECT pg_advisory_unlock($1)',
          [LOCK_KEY]
        );
      }
    } catch (error) {
      if (client) {
        client.release(error);
        client = null;
      }
    } finally {
      if (client) client.release();
      running = false;
    }
  }
}

export function startEventImagePublicationWorker() {
  if (timer) return;

  if (
    process.env.EVENT_IMAGE_REMOTE_PUBLISH_ENABLED
      !== 'true'
  ) {
    console.log(
      '[EVENT IMAGE WORKER] Disabilitato'
    );
    return;
  }

  console.log(
    '[EVENT IMAGE WORKER] Avviato'
  );

  timer = setInterval(
    runPublicationQueue,
    INTERVAL_MS
  );

  void runPublicationQueue();
}

export function stopEventImagePublicationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
