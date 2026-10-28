// services/pixel/pixel-stop-acquisition.service.js
// Politica temporanea Turentu: le fermate ATTIVE sono prenotabili anche se non verificate.
// Restano escluse fermate TEST, nodi inattivi ed evidenze esplicite 'non_ammessa'.
// Il campo 'verificata' NON viene modificato; Google Places resta solo discovery.
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
 * Stato del catalogo secondo la politica operativa provvisoria.
 * 'commerciali' indica fermate utilizzabili nella ricerca, NON certificate.
 */
export async function getPixelStopCatalogStatus(nodoId, { database = pool } = {}) {
  const id = normalizeNodeId(nodoId);
  const { rows } = await database.query(`
    WITH fermate AS (
      SELECT f.id, f.verificata,
        (
          f.attiva IS TRUE
          AND n.attivo IS TRUE
          AND f.nome !~* '^\\s*(\\[TEST PIXEL\\]|TEST PIXEL\\b)'
          AND NOT EXISTS (
            SELECT 1 FROM public.pixel_fermate_test_metadata t
            WHERE t.fermata_id = f.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.pixel_fermate_fonti ff
            WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
          )
        ) AS operativa
      FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
      WHERE f.nodo_territoriale_id = $1::bigint
    )
    SELECT COUNT(*)::integer AS censite,
      COUNT(*) FILTER (WHERE operativa)::integer AS commerciali,
      COUNT(*) FILTER (WHERE operativa AND verificata IS TRUE)::integer AS verificate_commerciali,
      COUNT(*) FILTER (WHERE operativa AND verificata IS NOT TRUE)::integer AS provvisorie_operative
    FROM fermate
  `, [id]);
  const r = rows[0] ?? {};
  const censite = Number(r.censite ?? 0);
  const commerciali = Number(r.commerciali ?? 0);
  return {
    censite,
    commerciali,
    non_ammesse: censite - commerciali,
    verificate_commerciali: Number(r.verificate_commerciali ?? 0),
    provvisorie_operative: Number(r.provvisorie_operative ?? 0),
  };
}

/**
 * Stato per Search: nessuna modifica a fermate o attestazioni.
 * Le fermate operative provvisorie sono disponibili alla ricerca.
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
    return {
      stato: 'nodo_non_disponibile', nodo_id: id,
      inserite: 0, ammesse: 0, pixel_fermate_disponibili: false,
    };
  }

  const catalogo = await getPixelStopCatalogStatus(id, { database });
  if (catalogo.commerciali > 0) {
    return {
      stato: 'fermate_commerciali_presenti',
      nodo_id: id,
      ...catalogo,
      inserite: 0,
      ammesse: 0,
      pixel_fermate_disponibili: true,
      politica: 'attive_anche_non_verificate',
    };
  }

  // Google Places: sola discovery, senza registrazione o attivazione.
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
