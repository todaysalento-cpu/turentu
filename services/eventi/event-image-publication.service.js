import { pool } from '../../db/db.js';
import { uploadEventImage } from './event-image.service.js';

export async function approveEventImage(
  candidateId,
  { licenza, attribuzione = null }
) {
  if (typeof licenza !== 'string' || !licenza.trim()) {
    throw new Error('Licenza obbligatoria');
  }

  const { rows } = await pool.query(`
    UPDATE public.event_image_candidates
    SET
      stato = 'approved',
      diritti_verificati = true,
      licenza = $2,
      attribuzione = $3,
      reviewed_at = NOW()
    WHERE id = $1
      AND stato = 'pending'
    RETURNING *
  `, [
    candidateId,
    licenza.trim(),
    attribuzione
  ]);

  if (!rows.length) {
    throw new Error('Candidata non approvabile');
  }

  return rows[0];
}

export async function publishEventImage(
  candidateId,
  buffer
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      SELECT
        c.*,
        e.immagine_url AS copertina_attuale
      FROM public.event_image_candidates c
      JOIN public.eventi e
        ON e.id = c.evento_id
      WHERE c.id = $1
      FOR UPDATE OF c, e
    `, [candidateId]);

    if (!rows.length) {
      throw new Error('Candidata non trovata');
    }

    const candidate = rows[0];

    if (candidate.stato === 'published') {
      await client.query('COMMIT');

      return {
        stato: 'GIA_PUBBLICATA',
        eventoId: candidate.evento_id
      };
    }

    if (
      candidate.stato !== 'approved' ||
      !candidate.diritti_verificati ||
      !candidate.licenza?.trim()
    ) {
      throw new Error(
        'Candidata non approvata o diritti non verificati'
      );
    }

    if (candidate.copertina_attuale?.trim()) {
      throw new Error(
        'Evento con copertina gia presente'
      );
    }

    const image = await uploadEventImage(buffer);

    const { rows: assets } = await client.query(`
      INSERT INTO public.event_image_assets (
        sha256,
        cloudinary_public_id,
        immagine_url,
        bytes,
        larghezza,
        altezza,
        formato
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (sha256)
      DO UPDATE SET sha256 = EXCLUDED.sha256
      RETURNING id, immagine_url
    `, [
      image.hash,
      image.publicId,
      image.url,
      image.bytes,
      image.width,
      image.height,
      image.format
    ]);

    const asset = assets[0];

    const updated = await client.query(`
      UPDATE public.eventi
      SET immagine_url = $2
      WHERE id = $1
        AND NULLIF(TRIM(immagine_url), '') IS NULL
    `, [
      candidate.evento_id,
      asset.immagine_url
    ]);

    if (updated.rowCount !== 1) {
      throw new Error(
        'Aggiornamento copertina non riuscito'
      );
    }

    await client.query(`
      UPDATE public.event_image_candidates
      SET
        stato = 'published',
        asset_id = $2,
        published_at = NOW(),
        errore = NULL
      WHERE id = $1
    `, [
      candidateId,
      asset.id
    ]);

    await client.query('COMMIT');

    return {
      stato: 'PUBBLICATA',
      eventoId: candidate.evento_id,
      candidateId,
      assetId: asset.id,
      url: asset.immagine_url,
      bytes: image.bytes
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;

  } finally {
    client.release();
  }
}