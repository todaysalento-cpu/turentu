// services/pixel/pixel-stop-registration.service.js
// Registrazione atomica di fermata, provenienza e attivazione provvisoria.
// NON passare direttamente risultati Google Places a questa funzione.
// L'attivazione provvisoria NON equivale a certificazione.
import { pool } from '../../db/db.js';
import { insertPixelStopCandidate } from './pixel-stop-budget.service.js';

const SOURCES = new Set(['rilievo_operatore', 'fonte_pubblica_riutilizzabile']);

function isSyntheticStopName(name) {
  return /^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(String(name ?? ''));
}

export async function registerPixelStopCandidate({
  nodo_territoriale_id, nome, indirizzo = null, lat, lon,
  fonte, riferimento_fonte, autorizzazione_uso_dati = false,
  conferma_punto_salita = false,
}) {
  if (!SOURCES.has(fonte)) {
    throw new Error('Fonte non ammessa: vietato registrare direttamente dati Google Places');
  }
  if (autorizzazione_uso_dati !== true ||
      typeof riferimento_fonte !== 'string' || !riferimento_fonte.trim()) {
    throw new Error('Servono diritti di riutilizzo e riferimento della fonte');
  }
  if (conferma_punto_salita !== true) {
    throw new Error('Punto di salita non ancora confermato');
  }
  // Non creare nuove fermate sintetiche nel flusso operativo.
  if (isSyntheticStopName(nome)) {
    throw new Error('PIXEL: fermata sintetica esclusa dalla registrazione operativa');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await insertPixelStopCandidate({
      nodo_territoriale_id, nome, indirizzo, lat, lon,
    }, { client });

    if (!result.inserted && result.reason !== 'duplicata_vicina') {
      await client.query('COMMIT');
      return { ...result, fonte_registrata: false, attivazione_provvisoria: false };
    }

    const fermataId = result.inserted ? result.id : result.existing_id;
    if (!result.inserted &&
        String(result.existing_nodo_territoriale_id) !== String(nodo_territoriale_id)) {
      await client.query('COMMIT');
      return {
        ...result,
        fonte_registrata: false,
        reason: 'duplicata_altro_nodo',
        attivazione_provvisoria: false,
      };
    }

    // Blocca la fermata prima di esaminare o aggiornare la sua ammissibilita'.
    // Vale anche per il caso di duplicato gia' esistente.
    const { rows: stopRows } = await client.query(`
      SELECT f.id, f.nome, f.attiva, f.verificata,
             n.attivo AS nodo_attivo,
             EXISTS (
               SELECT 1 FROM public.pixel_fermate_test_metadata t
               WHERE t.fermata_id = f.id
             ) AS fermata_test,
             EXISTS (
               SELECT 1 FROM public.pixel_fermate_fonti ff
               WHERE ff.fermata_id = f.id
                 AND ff.stato_verifica = 'non_ammessa'
             ) AS evidenza_negativa
      FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
      WHERE f.id = $1::bigint
      FOR UPDATE OF f
    `, [fermataId]);
    const stop = stopRows[0];
    if (!stop) throw new Error('PIXEL: fermata non trovata dopo il censimento');

    // La fonte puo' essere registrata, ma nessun test o rifiuto esplicito
    // deve essere trasformato in una fermata operativa.
    const ammissibileProvvisoria =
      stop.nodo_attivo === true &&
      stop.fermata_test !== true &&
      !isSyntheticStopName(stop.nome) &&
      stop.evidenza_negativa !== true;

    // I prerequisiti sono dichiarazioni, NON prove di certificazione.
    const source = await client.query(
      `INSERT INTO public.pixel_fermate_fonti
       (fermata_id, fonte, riferimento_fonte, stato_verifica, dettagli_verifica)
       VALUES ($1::bigint, $2, $3, 'da_verificare', $4::jsonb)
       ON CONFLICT (fermata_id, fonte, riferimento_fonte)
       DO NOTHING
       RETURNING id`,
      [fermataId, fonte, riferimento_fonte.trim(), JSON.stringify({
        autorizzazione_uso_dati_dichiarata: true,
        conferma_punto_salita_dichiarata: true,
      })]
    );

    let attiva = stop.attiva === true;
    if (ammissibileProvvisoria && !attiva) {
      const activation = await client.query(`
        UPDATE public.pixel_fermate
        SET attiva = TRUE, updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING attiva
      `, [fermataId]);
      attiva = activation.rows[0]?.attiva === true;
    }

    await client.query('COMMIT');
    return {
      ...result,
      fermata_id: fermataId,
      fonte_registrata: source.rowCount > 0,
      stato_verifica: stop.verificata === true ? 'verificata' : 'da_verificare',
      verificata: stop.verificata === true,
      attiva,
      attivazione_provvisoria: ammissibileProvvisoria && attiva && stop.verificata !== true,
      motivo_non_attivazione: ammissibileProvvisoria ? null :
        (!stop.nodo_attivo ? 'nodo_inattivo' :
          (stop.fermata_test || isSyntheticStopName(stop.nome)) ? 'fermata_test' :
          'evidenza_negativa'),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
