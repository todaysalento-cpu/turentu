import { pool } from '../../db/db.js';
import { uploadEventImageBase64 } from './event-image.service.js';

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export async function publishManualEventImage({
  eventIds,
  immagine,
  licenza,
  attribuzione,
  diritti_verificati
}) {
  if (
    !Array.isArray(eventIds) ||
    !eventIds.length ||
    eventIds.length > 50
  ) {
    fail('Selezionare da 1 a 50 eventi');
  }

  const ids = [...new Set(eventIds.map(Number))]
    .sort((a, b) => a - b);

  if (
    ids.some(id =>
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      id > 2147483647
    )
  ) {
    fail('ID eventi non validi');
  }

  if (
    diritti_verificati !== true ||
    typeof licenza !== 'string' ||
    !licenza.trim()
  ) {
    fail('Licenza e conferma dei diritti obbligatorie');
  }

  if (
    attribuzione != null &&
    typeof attribuzione !== 'string'
  ) {
    fail('Attribuzione non valida');
  }

  if (
    typeof immagine !== 'string' ||
    !immagine.startsWith('data:image/')
  ) {
    fail('Immagine non valida');
  }

  if (immagine.length > 13981114) {
    fail('Immagine troppo grande', 413);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: events } = await client.query(`
      SELECT
        id,
        titolo,
        stato,
        immagine_url
      FROM public.eventi
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR UPDATE
    `, [ids]);

    if (events.length !== ids.length) {
      fail('Uno o più eventi non esistono', 404);
    }

    const eligible = events.filter(event =>
      event.stato === 'approvato' &&
      !event.immagine_url?.trim()
    );

    const skipped = events
      .filter(event =>
        event.stato !== 'approvato' ||
        event.immagine_url?.trim()
      )
      .map(event => ({
        id: event.id,
        titolo: event.titolo,
        motivo: event.stato !== 'approvato'
          ? 'EVENTO_NON_APPROVATO'
          : 'COPERTINA_PRESENTE'
      }));

    if (!eligible.length) {
      fail('Nessun evento disponibile per la pubblicazione', 409);
    }

    // Una sola ottimizzazione e un solo upload
    // per tutti gli eventi selezionati.

    const image = await uploadEventImageBase64(immagine);

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
    const published = [];

    for (const event of eligible) {
      await client.query(`
        INSERT INTO public.event_image_candidates (
          evento_id,
          asset_id,
          titolo_immagine,
          immagine_originale_url,
          confidenza,
          stato,
          diritti_verificati,
          licenza,
          attribuzione,
          note,
          reviewed_at,
          published_at
        )
        VALUES (
          $1,$2,$3,$4,100,'published',
          true,$5,$6,$7,NOW(),NOW()
        )
        ON CONFLICT (
          evento_id,
          immagine_originale_url
        )
        DO UPDATE SET
          asset_id = EXCLUDED.asset_id,
          stato = 'published',
          diritti_verificati = true,
          licenza = EXCLUDED.licenza,
          attribuzione = EXCLUDED.attribuzione,
          note = EXCLUDED.note,
          reviewed_at = NOW(),
          published_at = NOW(),
          errore = NULL
      `, [
        event.id,
        asset.id,
        event.titolo,
        'manual:' + image.hash,
        licenza.trim(),
        attribuzione?.trim() || null,
        'Caricamento manuale amministratore'
      ]);

      const updated = await client.query(`
        UPDATE public.eventi
        SET immagine_url = $2
        WHERE id = $1
          AND NULLIF(TRIM(immagine_url),'') IS NULL
      `, [
        event.id,
        asset.immagine_url
      ]);

      if (updated.rowCount !== 1) {
        fail('Aggiornamento evento non riuscito', 409);
      }

      published.push({
        id: event.id,
        titolo: event.titolo
      });
    }

    await client.query('COMMIT');

    return {
      stato: 'PUBBLICATA',
      assetId: asset.id,
      url: asset.immagine_url,
      bytes: image.bytes,
      larghezza: image.width,
      altezza: image.height,
      totalePubblicati: published.length,
      pubblicati: published,
      saltati: skipped
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}