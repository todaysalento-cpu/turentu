// services/pixel/pixel-stop-verifier.service.js
// PIXEL V1: verifica automatica, fail-closed, delle evidenze indipendenti.
// Non usa Google Places come attestazione di idoneita' e non modifica il DB.
import { pool } from '../../db/db.js';

const FONTI_AMMESSE = new Set(['rilievo_operatore', 'fonte_pubblica_riutilizzabile']);

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`PIXEL: ${field} non valido`);
  return id;
}

function validEvidence(row) {
  if (!FONTI_AMMESSE.has(row.fonte)) return false;
  if (row.stato_verifica !== 'verificata' || !row.verificata_il) return false;
  if (typeof row.riferimento_fonte !== 'string' || !row.riferimento_fonte.trim()) return false;
  const details = row.dettagli_verifica;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  // Questi attributi sono attestazioni registrate, NON inferenze da Google.
  // Il writer che le registra deve essere autenticato e autorizzato e
  // deve verificare realmente il documento/fonte prima di marcarle vere.
  if (details.autorizzazione_uso_dati !== true) return false;
  if (details.punto_salita_confermato !== true) return false;
  if (typeof details.verificatore !== 'string' || !details.verificatore.trim()) return false;
  if (typeof details.riferimento_evidenza !== 'string' || !details.riferimento_evidenza.trim()) return false;
  return true;
}

export async function verifyPixelStop(fermataId, { database = pool, lockEvidence = false } = {}) {
  const id = positiveId(fermataId, 'fermata_id');
  const { rows: stops } = await database.query(`
    SELECT f.id, f.nodo_territoriale_id, n.attivo AS nodo_attivo
      FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
     WHERE f.id = $1::bigint
  `, [id]);
  if (!stops.length) return { fermata_id: id, stato: 'inesistente', ammissibile: false, motivi: ['fermata_inesistente'] };
  if (!stops[0].nodo_attivo) return { fermata_id: id, stato: 'non_ammissibile', ammissibile: false, motivi: ['nodo_inattivo'] };

  const { rows } = await database.query(`
    SELECT fonte, riferimento_fonte, stato_verifica, dettagli_verifica, verificata_il
      FROM public.pixel_fermate_fonti
     WHERE fermata_id = $1::bigint
     ORDER BY created_at DESC, id DESC
     ${lockEvidence ? 'FOR SHARE' : ''}
  `, [id]);

  // Un esito negativo esplicito blocca l'ammissione, anche se esistono
  // altre attestazioni positive. Le controversie vanno risolte a monte.
  if (rows.some(r => r.stato_verifica === 'non_ammessa')) {
    return { fermata_id: id, stato: 'non_ammissibile', ammissibile: false, motivi: ['verifica_negativa'], evidenze: rows.length };
  }
  const valide = rows.filter(validEvidence);
  if (!valide.length) {
    return { fermata_id: id, stato: 'da_verificare', ammissibile: false, motivi: [rows.length ? 'evidenze_insufficienti' : 'nessuna_evidenza'], evidenze: rows.length };
  }
  return {
    fermata_id: id,
    stato: 'ammissibile',
    ammissibile: true,
    evidenze: rows.length,
    fonti_valide: valide.map(r => ({ fonte: r.fonte, riferimento_fonte: r.riferimento_fonte })),
  };
}

export async function verifyPixelNodeStops(nodoId, { database = pool } = {}) {
  const id = positiveId(nodoId, 'nodo_id');
  const { rows } = await database.query(
    'SELECT id FROM public.pixel_fermate WHERE nodo_territoriale_id = $1::bigint ORDER BY id', [id]
  );
  const risultati = [];
  for (const row of rows) risultati.push(await verifyPixelStop(row.id, { database }));
  return {
    nodo_id: id,
    censite: risultati.length,
    ammissibili: risultati.filter(r => r.ammissibile).length,
    risultati,
  };
}
