// services/pixel/pixel-stop-acquisition.service.js
// PIXEL: discovery Google Places e stato del catalogo commerciale.
// Non persiste contenuti Google Places e non attiva fermate automaticamente.
import { pool } from '../../db/db.js';
import { discoverPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';

function normalizeNodeId(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('PIXEL: nodoId non valido');
  const id = BigInt(raw);
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PIXEL: nodoId fuori intervallo');
  return raw;
}

/**
 * Recupera lo stato delle fermate PIXEL per un nodo territoriale.
 * Il catalogo commerciale comprende solo fermate attive e verificate.
 */
export async function getPixelStopCatalogStatus(nodoId, { database = pool } = {}) {
  const id = normalizeNodeId(nodoId);
  const { rows } = await database.query(`
    SELECT COUNT(*)::integer AS censite,
           COUNT(*) FILTER (WHERE attiva = TRUE AND verificata = TRUE)::integer AS commerciali,
           COUNT(*) FILTER (WHERE NOT (attiva = TRUE AND verificata = TRUE))::integer AS non_ammesse
      FROM public.pixel_fermate
     WHERE nodo_territoriale_id = $1::bigint
  `, [id]);
  return {
    censite: Number(rows[0]?.censite ?? 0),
    commerciali: Number(rows[0]?.commerciali ?? 0),
    non_ammesse: Number(rows[0]?.non_ammesse ?? 0),
  };
}

/**
 * Discovery on demand tramite Google Places, senza scritture.
 * Mantiene il nome storico per compatibilita' con Search.
 *
 * Le fermate Google sono candidati, NON fermate commercialmente ammesse.
 * La funzione non restituisce i dettagli dei Places: solo conteggi e stato.
 */
export async function ensurePixelStopsForNode(nodoId, { database = pool } = {}) {
  const id = normalizeNodeId(nodoId);
  const { rows } = await database.query(`
    SELECT id, codice_istat_comune
      FROM public.nodi_territoriali
     WHERE id = $1::bigint AND attivo = TRUE
  `, [id]);

  const node = rows[0];
  if (!node?.codice_istat_comune) {
    return { stato: 'nodo_non_disponibile', nodo_id: id, inserite: 0, ammesse: 0 };
  }

  const catalogo = await getPixelStopCatalogStatus(id, { database });
  if (catalogo.commerciali > 0) {
    return {
      stato: 'fermate_commerciali_presenti', nodo_id: id,
      ...catalogo, inserite: 0, ammesse: 0,
    };
  }

  // GOOGLE: discovery e selezione comunale; nessuna persistenza di Places.
  const plan = await discoverPixelComuneCandidates(
    String(node.codice_istat_comune), { source: 'GOOGLE', database }
  );

  const candidatiNodo = (plan.selezionati ?? []).filter(candidate =>
    (candidate.nodi_raggiungibili ?? []).some(n => String(n) === id)
  ).length;

  return {
    stato: plan.stato === 'ok' ? 'candidati_google_non_ammessi' : 'discovery_non_completa',
    nodo_id: id,
    comune: String(node.codice_istat_comune),
    ...catalogo,
    limite_comunale: plan.limite ?? null,
    budget_residuo: plan.residue ?? null,
    candidati_selezionati_per_nodo: candidatiNodo,
    errori: plan.errori ?? [],
    inserite: 0,
    ammesse: 0,
    pixel_fermate_disponibili: false,
    nota: 'Google Places usato solo per discovery; nessuna scrittura o attivazione commerciale.',
  };
}
