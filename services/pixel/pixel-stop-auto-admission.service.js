// services/pixel/pixel-stop-auto-admission.service.js
// PIXEL: riconciliazione automatica delle fermate con verifica indipendente.
// Google Places e' SOLO discovery: non persiste risultati e non produce attestazioni.
import { pool } from '../../db/db.js';
import { discoverPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';
import { admitPixelStop } from './pixel-stop-admission.service.js';
import { verifyPixelStop } from './pixel-stop-verifier.service.js';

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('PIXEL: nodo territoriale non valido');
  }
  return id;
}

/**
 * Attiva le sole fermate del nodo con attestazione indipendente GIA' registrata.
 * Non crea fermate da Google Places e non scrive mai stato_verifica='verificata'.
 * Opzioni: discoverGoogle=true per mantenere la diagnostica candidati;
 *          dryRun=true per simulare senza attivare alcuna fermata.
 */
export async function acquirePixelStopsForNode(nodoId, {
  database = pool,
  discoverGoogle = true,
  dryRun = false,
} = {}) {
  const id = positiveId(nodoId);
  const { rows: nodes } = await database.query(`
    SELECT id, codice_istat_comune
    FROM public.nodi_territoriali
    WHERE id = $1::bigint AND attivo = TRUE
  `, [id]);
  const node = nodes[0];
  if (!node?.codice_istat_comune) {
    return { stato: 'nodo_non_disponibile', nodo_id: id, inserite: 0, ammesse: 0 };
  }

  // Verifica completa, inclusi esiti negativi e dettagli dell'attestazione.
  // La decisione viene ripetuta in transazione da Admission.
  const { rows: pending } = await database.query(`
    SELECT id FROM public.pixel_fermate
    WHERE nodo_territoriale_id = $1::bigint
      AND (attiva = FALSE OR verificata = FALSE)
    ORDER BY id
  `, [id]);
  const eligible = [];
  const esiti_verifica = [];
  for (const stop of pending) {
    const result = await verifyPixelStop(stop.id, { database });
    esiti_verifica.push({ fermata_id: String(stop.id), stato: result.stato,
      motivi: result.motivi ?? [] });
    if (result.ammissibile) eligible.push(stop);
  }

  let ammesse = 0;
  const errori_ammissione = [];
  for (const stop of eligible) {
    if (dryRun) continue;
    try {
      await admitPixelStop({ fermata_id: stop.id }, { database });
      ammesse++;
    } catch (error) {
      errori_ammissione.push({ fermata_id: String(stop.id), errore: error.message });
    }
  }

  const { rows: counts } = await database.query(`
    SELECT COUNT(*)::integer AS censite,
           COUNT(*) FILTER (WHERE attiva = TRUE AND verificata = TRUE)::integer AS commerciali
    FROM public.pixel_fermate
    WHERE nodo_territoriale_id = $1::bigint
  `, [id]);

  let candidati_selezionati = null;
  let stato_discovery = 'non_eseguita';
  let errori_discovery = [];
  if (discoverGoogle) {
    try {
      const plan = await discoverPixelComuneCandidates(
        String(node.codice_istat_comune), { source: 'GOOGLE', database }
      );
      stato_discovery = plan.stato ?? 'sconosciuto';
      candidati_selezionati = (plan.selezionati ?? []).filter(c =>
        (c.nodi_raggiungibili ?? []).some(n => String(n) === String(id))
      ).length;
      errori_discovery = plan.errori ?? [];
    } catch (error) {
      stato_discovery = 'errore';
      errori_discovery = [error.message];
    }
  }

  const commerciali = Number(counts[0]?.commerciali ?? 0);
  return {
    stato: commerciali > 0 ? 'fermate_commerciali_presenti' :
      eligible.length > 0 && dryRun ? 'ammissioni_simulate' : 'nessuna_fermata_ammissibile',
    nodo_id: id,
    comune: String(node.codice_istat_comune),
    censite: Number(counts[0]?.censite ?? 0),
    commerciali,
    verifiche_ammissibili: eligible.length,
    ammesse,
    inserite: 0,
    dry_run: dryRun,
    pixel_fermate_disponibili: commerciali > 0,
    candidati_google_selezionati: candidati_selezionati,
    stato_discovery,
    errori_discovery,
    errori_ammissione,
    esiti_verifica,
    nota: 'Google Places non genera registrazioni o verifiche commerciali.'
  };
}
