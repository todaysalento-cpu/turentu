// Turentu POPBUS + PIXEL — validazione server-side condivisa (Stripe / wallet).
// Usare ESCLUSIVAMENTE il client pg della transazione corrente (BEGIN ... COMMIT/ROLLBACK).
// Fail closed: nodi territoriali PIXEL autorevoli obbligatori; fermate operative assegnate dal worker.

const pixelError = (message, status = 422) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// Le chiavi PostgreSQL sono bigint: validiamo ID rappresentabili senza perdita
// di precisione in JavaScript, e li passiamo al driver come stringhe.
const integerId = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) return null;
  try {
    const id = BigInt(str);
    return id <= BigInt(Number.MAX_SAFE_INTEGER) ? str : null;
  } catch {
    return null;
  }
};

export function isPopbusSlot(slot) {
  const kind = String(slot?.tipo ?? slot?.tipo_corsa ?? '')
    .toLowerCase()
    .replace(/[-_\s]/g, '');
  const id = String(slot?.id ?? '');
  return kind === 'popbus' || id.startsWith('virtual_pop_') ||
    id.startsWith('dir_') || id === 'nuova_proposta';
}

/**
 * Valida i nodi territoriali del preventivo fresco PIXEL, nella transazione corrente.
 * Le fermate fisiche sono assegnate successivamente da POPBUS V2.
 * Non accetta nodi territoriali autorevoli dal payload del client.
 */
export async function validatePixelStops(client, slot, quotation = null) {
  if (!isPopbusSlot(slot)) return null;
  if (!client || typeof client.query !== 'function') {
    throw pixelError('PIXEL: connessione transazionale non disponibile', 503);
  }
  if (!quotation || !isPopbusSlot(quotation)) {
    throw pixelError('PIXEL: quotazione POPBUS autorevole mancante', 409);
  }
  const originNode = integerId(quotation.origine_nodo_territoriale_id);
  const destNode = integerId(quotation.destinazione_nodo_territoriale_id);
  if (!originNode || !destNode || originNode === destNode) {
    throw pixelError('PIXEL: nodi territoriali del preventivo mancanti o non validi', 409);
  }
  const result = await client.query(
    `SELECT id, attivo FROM public.nodi_territoriali
      WHERE id = ANY($1::bigint[]) ORDER BY id FOR SHARE`,
    [[originNode, destNode]]
  );
  const origin = result.rows.find(row => String(row.id) === originNode);
  const destination = result.rows.find(row => String(row.id) === destNode);
  if (!origin || !destination || origin.attivo !== true || destination.attivo !== true) {
    throw pixelError('PIXEL: nodi territoriali non esistenti o inattivi', 409);
  }
  return {
    origine_nodo_territoriale_id: originNode,
    destinazione_nodo_territoriale_id: destNode,
    origine_fermata_id: null,
    destinazione_fermata_id: null
  };
}
