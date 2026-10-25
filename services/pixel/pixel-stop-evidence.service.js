// services/pixel/pixel-stop-evidence.service.js
// Registrazione di evidenze indipendenti, inizialmente NON verificate.
// Il servizio non attesta la sicurezza del punto di salita e non attiva fermate.
import { pool } from '../../db/db.js';

const FONTI = new Set(['rilievo_operatore', 'fonte_pubblica_riutilizzabile']);

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`PIXEL: ${field} non valido`);
  return id;
}

function requiredString(value, field, maxLength = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`PIXEL: ${field} non valido`);
  }
  return value.trim();
}

/**
 * Accoda un'evidenza da verificare per una fermata PIXEL esistente.
 *
 * ATTENZIONE: chiamare esclusivamente da un backend autenticato e autorizzato.
 * Non esporre direttamente come endpoint pubblico; il controllo degli accessi
 * e l'acquisizione dei documenti devono essere implementati a monte.
 *
 * I dettagli qui registrati sono dichiarazioni, NON attestazioni verificate.
 * Il servizio non accetta stato_verifica, verificata_il o flag di ammissione.
 */
export async function submitPixelStopEvidence({
  fermata_id,
  fonte,
  riferimento_fonte,
  riferimento_evidenza,
  descrizione = null,
}, { database = pool } = {}) {
  const fermataId = positiveId(fermata_id, 'fermata_id');
  if (!FONTI.has(fonte)) throw new Error('PIXEL: fonte non ammessa');
  const riferimentoFonte = requiredString(riferimento_fonte, 'riferimento_fonte');
  const riferimentoEvidenza = requiredString(riferimento_evidenza, 'riferimento_evidenza');
  if (descrizione !== null && (typeof descrizione !== 'string' || descrizione.length > 4000)) {
    throw new Error('PIXEL: descrizione non valida');
  }

  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const stop = await client.query(`
      SELECT f.id, f.attiva, n.attivo AS nodo_attivo
        FROM public.pixel_fermate f
        JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
       WHERE f.id = $1::bigint
       FOR UPDATE OF f
    `, [fermataId]);
    if (!stop.rowCount) throw new Error('PIXEL: fermata inesistente');
    if (!stop.rows[0].nodo_attivo) throw new Error('PIXEL: nodo inattivo');

    // Non sovrascrivere evidenze esistenti: una verifica positiva/negativa
    // deve poter essere riesaminata e conservata senza alterazioni implicite.
    const existing = await client.query(`
      SELECT id, stato_verifica
        FROM public.pixel_fermate_fonti
       WHERE fermata_id = $1::bigint AND fonte = $2 AND riferimento_fonte = $3
       FOR UPDATE
    `, [fermataId, fonte, riferimentoFonte]);
    if (existing.rowCount) {
      await client.query('COMMIT');
      return {
        inserita: false,
        motivo: 'riferimento_gia_registrato',
        evidenza_id: String(existing.rows[0].id),
        stato_verifica: existing.rows[0].stato_verifica,
      };
    }

    const inserted = await client.query(`
      INSERT INTO public.pixel_fermate_fonti
        (fermata_id, fonte, riferimento_fonte, stato_verifica,
         dettagli_verifica, verificata_il)
      VALUES ($1::bigint, $2, $3, 'da_verificare', $4::jsonb, NULL)
      ON CONFLICT (fermata_id, fonte, riferimento_fonte) DO NOTHING
      RETURNING id
    `, [fermataId, fonte, riferimentoFonte, JSON.stringify({
      riferimento_evidenza: riferimentoEvidenza,
      descrizione,
      origine: 'dichiarazione_non_verificata',
    })]);
    await client.query('COMMIT');
    return inserted.rowCount
      ? { inserita: true, evidenza_id: String(inserted.rows[0].id), stato_verifica: 'da_verificare' }
      : { inserita: false, motivo: 'riferimento_gia_registrato' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listPixelStopEvidence(fermataId, { database = pool } = {}) {
  const id = positiveId(fermataId, 'fermata_id');
  const { rows } = await database.query(`
    SELECT id, fermata_id, fonte, riferimento_fonte, stato_verifica,
           dettagli_verifica, verificata_il, created_at, updated_at
      FROM public.pixel_fermate_fonti
     WHERE fermata_id = $1::bigint
     ORDER BY created_at DESC, id DESC
  `, [id]);
  return rows;
}
