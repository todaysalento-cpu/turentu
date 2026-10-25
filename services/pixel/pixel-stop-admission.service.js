// services/pixel/pixel-stop-admission.service.js
// Decisione commerciale centralizzata: il verificatore e' obbligatorio.
import { pool } from '../../db/db.js';
import { verifyPixelStop } from './pixel-stop-verifier.service.js';

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('PIXEL: fermata_id non valido');
  return id;
}

export async function admitPixelStop({ fermata_id }, { database = pool } = {}) {
  const id = positiveId(fermata_id);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serializza le ammissioni della stessa fermata.
    const { rows } = await client.query(`
      SELECT f.id, f.attiva, f.verificata, n.attivo AS nodo_attivo
      FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
      WHERE f.id = $1::bigint
      FOR UPDATE OF f
    `, [id]);
    if (!rows.length) throw new Error('PIXEL: fermata inesistente');
    if (!rows[0].nodo_attivo) throw new Error('PIXEL: nodo territoriale inattivo');

    // Valuta le evidenze all'interno della stessa transazione.
    // Blocca gli aggiornamenti alle righe di evidenza gia' esistenti.
    const verifica = await verifyPixelStop(id, { database: client, lockEvidence: true });
    if (!verifica.ammissibile) {
      throw new Error(`PIXEL: fermata non ammissibile (${verifica.motivi.join(', ')})`);
    }

    const { rows: updated } = await client.query(`
      UPDATE public.pixel_fermate
      SET verificata = TRUE, attiva = TRUE, updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING id, nodo_territoriale_id, verificata, attiva
    `, [id]);
    await client.query('COMMIT');
    return { success: true, gia_attiva: rows[0].attiva && rows[0].verificata,
      fermata: updated[0], verifica };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
