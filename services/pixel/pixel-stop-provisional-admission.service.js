
import { pool } from '../../db/db.js';

export async function admitPixelStopProvisionally(
  { fermata_id },
  { database = pool, dryRun = true } = {}
) {
  const id = String(fermata_id ?? '').trim();

  if (!/^[1-9]\d*$/.test(id)) {
    throw new Error('PIXEL: fermata_id non valido');
  }

  const client = await database.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      SELECT
        f.id,
        f.nome,
        f.attiva,
        f.verificata,
        n.attivo AS nodo_attivo,
        EXISTS (
          SELECT 1
          FROM public.pixel_fermate_test_metadata t
          WHERE t.fermata_id = f.id
        ) AS fermata_test,
        EXISTS (
          SELECT 1
          FROM public.pixel_fermate_fonti ff
          WHERE ff.fermata_id = f.id
            AND ff.stato_verifica = 'non_ammessa'
        ) AS evidenza_negativa
      FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n
        ON n.id = f.nodo_territoriale_id
      WHERE f.id = $1::bigint
      FOR UPDATE OF f
    `, [id]);

    const stop = rows[0];

    if (!stop) {
      throw new Error('PIXEL: fermata inesistente');
    }

    if (!stop.nodo_attivo) {
      throw new Error('PIXEL: nodo territoriale inattivo');
    }

    if (
      stop.fermata_test ||
      /^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(stop.nome)
    ) {
      throw new Error('PIXEL: fermata di test esclusa');
    }

    if (stop.evidenza_negativa) {
      throw new Error('PIXEL: evidenza negativa presente');
    }

    if (dryRun) {
      await client.query('ROLLBACK');

      return {
        fermata_id: id,
        ammissibile: true,
        simulazione: true,
        gia_attiva: stop.attiva
      };
    }

    await client.query(`
      UPDATE public.pixel_fermate
      SET attiva = TRUE,
          updated_at = NOW()
      WHERE id = $1::bigint
    `, [id]);

    await client.query('COMMIT');

    return {
      fermata_id: id,
      attiva: true,
      verificata: stop.verificata,
      modalita: 'PROVISIONAL'
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
