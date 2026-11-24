
import { pool } from '../../db/db.js';

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export async function createPublicationJob({
  candidateIds,
  licenza,
  attribuzione = '',
  diritti_verificati,
  actorId = null,
}) {
  if (
    !Array.isArray(candidateIds) ||
    !candidateIds.length ||
    candidateIds.length > 100
  ) {
    throw failure('Selezionare da 1 a 100 candidate');
  }

  const ids = [...new Set(candidateIds.map(String))];

  if (ids.some(id => !/^[1-9]\d{0,17}$/.test(id))) {
    throw failure('Identificativi non validi');
  }

  if (
    diritti_verificati !== true ||
    typeof licenza !== 'string' ||
    !licenza.trim() ||
    licenza.length > 2000 ||
    typeof attribuzione !== 'string' ||
    attribuzione.length > 2000
  ) {
    throw failure('Licenza e verifica dei diritti obbligatorie');
  }

  if (process.env.EVENT_IMAGE_REMOTE_PUBLISH_ENABLED !== 'true') {
    throw failure('Pubblicazione remota non abilitata', 403);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      SELECT
        c.id,
        c.evento_id,
        c.stato,
        s.download_abilitato,
        s.licenza AS licenza_fonte,
        s.verificato_il,
        e.stato AS stato_evento,
        e.immagine_url
      FROM public.event_image_candidates c
      JOIN public.eventi e ON e.id = c.evento_id
      LEFT JOIN public.event_image_sources s
        ON s.id = c.source_id
      WHERE c.id = ANY($1::bigint[])
      ORDER BY c.id
      FOR UPDATE OF c
    `, [ids]);

    if (rows.length !== ids.length) {
      throw failure('Una o piu candidate non esistono', 404);
    }

    const eligible = [];
    const skipped = [];
    const eventIds = new Set();

    for (const row of rows) {
      let motivo = null;

      if (!['pending', 'approved'].includes(row.stato)) {
        motivo = 'Stato candidata non valido';
      } else if (row.stato_evento !== 'approvato') {
        motivo = 'Evento non approvato';
      } else if (String(row.immagine_url || '').trim()) {
        motivo = 'Evento gia provvisto di copertina';
      } else if (
        !row.download_abilitato ||
        !row.licenza_fonte ||
        !row.verificato_il
      ) {
        motivo = 'Fonte non autorizzata';
      } else if (eventIds.has(String(row.evento_id))) {
        motivo = 'Altra candidata selezionata per lo stesso evento';
      }

      if (!motivo) {
        const active = await client.query(`
          SELECT id
          FROM public.event_image_publication_items
          WHERE candidate_id = $1
            AND stato IN ('pending', 'running')
          LIMIT 1
        `, [row.id]);

        if (active.rowCount) {
          motivo = 'Pubblicazione gia in corso';
        }
      }

      if (motivo) {
        skipped.push({
          candidateId: row.id,
          motivo,
        });
      } else {
        eligible.push(row.id);
        eventIds.add(String(row.evento_id));
      }
    }

    if (!eligible.length) {
      throw failure(
        'Nessuna candidata pubblicabile: ' +
        [...new Set(skipped.map(s => s.motivo))].join('; '),
        409
      );
    }

    const job = await client.query(`
      INSERT INTO public.event_image_publication_jobs
        (created_by, stato)
      VALUES ($1, 'pending')
      RETURNING id, stato, created_at
    `, [actorId]);

    const jobId = job.rows[0].id;

    for (const id of eligible) {
      await client.query(`
        UPDATE public.event_image_candidates
        SET stato = 'approved',
            diritti_verificati = TRUE,
            licenza = $2,
            attribuzione = $3,
            reviewed_at = NOW()
        WHERE id = $1
      `, [
        id,
        licenza.trim(),
        attribuzione.trim() || null,
      ]);

      await client.query(`
        INSERT INTO public.event_image_publication_items
          (job_id, candidate_id, stato)
        VALUES ($1, $2, 'pending')
      `, [jobId, id]);
    }

    await client.query('COMMIT');

    return {
      jobId,
      stato: 'pending',
      totale: eligible.length,
      saltate: skipped,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listPublicationJobs() {
  const { rows } = await pool.query(`
    SELECT
      j.id,
      j.stato,
      j.created_at,
      j.started_at,
      j.finished_at,
      COUNT(i.id)::integer AS totale,
      COUNT(i.id) FILTER (
        WHERE i.stato = 'pending'
      )::integer AS pending,
      COUNT(i.id) FILTER (
        WHERE i.stato = 'running'
      )::integer AS running,
      COUNT(i.id) FILTER (
        WHERE i.stato = 'published'
      )::integer AS pubblicate,
      COUNT(i.id) FILTER (
        WHERE i.stato = 'skipped'
      )::integer AS saltate,
      COUNT(i.id) FILTER (
        WHERE i.stato = 'error'
      )::integer AS errori
    FROM public.event_image_publication_jobs j
    LEFT JOIN public.event_image_publication_items i
      ON i.job_id = j.id
    GROUP BY j.id
    ORDER BY j.id DESC
    LIMIT 50
  `);

  return rows;
}

export async function getPublicationJob(jobId) {
  if (!/^[1-9]\d{0,17}$/.test(String(jobId))) {
    throw failure('Job non valido');
  }

  const job = await pool.query(`
    SELECT *
    FROM public.event_image_publication_jobs
    WHERE id = $1
  `, [jobId]);

  if (!job.rowCount) {
    throw failure('Job non trovato', 404);
  }

  const items = await pool.query(`
    SELECT
      i.*,
      c.evento_id,
      e.titolo AS evento_titolo
    FROM public.event_image_publication_items i
    JOIN public.event_image_candidates c
      ON c.id = i.candidate_id
    JOIN public.eventi e
      ON e.id = c.evento_id
    WHERE i.job_id = $1
    ORDER BY i.id
  `, [jobId]);

  return {
    ...job.rows[0],
    items: items.rows,
  };
}
