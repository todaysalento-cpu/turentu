// Turentu POPBUS + PIXEL — validazione server-side condivisa (Stripe / wallet).
// Usare ESCLUSIVAMENTE il client pg della transazione corrente (BEGIN ... COMMIT/ROLLBACK).
// Fail closed: nessuna richiesta POPBUS senza coppia PIXEL verificabile.

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

const normalizeType = (value) => String(value ?? '').trim().toLowerCase();
const allowedTypes = new Set(['ncc', 'navetta', 'autobus']);

const vehicleTypes = (value) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeType).filter(type => allowedTypes.has(type)))];
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
 * Verifica i riferimenti PIXEL e restituisce gli identificativi normalizzati.
 *
 * @param {import('pg').PoolClient} client Client della transazione attiva.
 * @param {object} slot Slot selezionato + quattro ID PIXEL inviati dal client.
 * @param {object|null} quotation Preventivo fresco ricalcolato dal server.
 * @returns {Promise<object|null>} null solo per slot NON POPBUS.
 *
 * IMPORTANTE: chiamare prima di wallet debit, Stripe PaymentIntent e INSERT.
 * Non chiamare con pool.query: i lock FOR SHARE devono durare fino al COMMIT.
 */
export async function validatePixelStops(client, slot, quotation = null) {
  if (!isPopbusSlot(slot)) return null;

  if (!client || typeof client.query !== 'function') {
    throw pixelError('PIXEL: connessione transazionale non disponibile', 503);
  }

  const pickupId = integerId(slot?.origine_fermata_id);
  const dropoffId = integerId(slot?.destinazione_fermata_id);
  const originNode = integerId(slot?.origine_nodo_territoriale_id);
  const destNode = integerId(slot?.destinazione_nodo_territoriale_id);

  if (!pickupId || !dropoffId || !originNode || !destNode || pickupId === dropoffId) {
    throw pixelError('PIXEL: due fermate distinte e relativi nodi territoriali obbligatori');
  }

  // Il preventivo fresco e' la fonte autorevole per i nodi territoriali.
  // Quando segnala esplicitamente fermate non disponibili, non si puo' procedere.
  if (quotation) {
    const quotedOrigin = integerId(quotation.origine_nodo_territoriale_id);
    const quotedDestination = integerId(quotation.destinazione_nodo_territoriale_id);
    if (!quotedOrigin || !quotedDestination ||
        quotedOrigin !== originNode || quotedDestination !== destNode ||
        quotation.pixel_fermate_disponibili !== true) {
      throw pixelError('PIXEL: fermate non disponibili o nodi non coerenti con il preventivo', 409);
    }
  }

  // Le fermate sono bigint nel DB; PostgreSQL restituisce bigint come stringhe.
  // FOR SHARE protegge le righe da disattivazioni/modifiche concorrenti fino
  // al termine della transazione chiamante.
  const stopsResult = await client.query(
    `SELECT id, nodo_territoriale_id, attiva, verificata, tipi_veicolo_ammessi
       FROM public.pixel_fermate
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      FOR SHARE`,
    [[pickupId, dropoffId]]
  );

  const pickup = stopsResult.rows.find(row => String(row.id) === pickupId);
  const dropoff = stopsResult.rows.find(row => String(row.id) === dropoffId);

  if (!pickup || !dropoff) {
    throw pixelError('PIXEL: una o entrambe le fermate non esistono');
  }
  if (pickup.attiva !== true || pickup.verificata !== true ||
      dropoff.attiva !== true || dropoff.verificata !== true) {
    throw pixelError('PIXEL: fermate non attive o non verificate');
  }
  if (String(pickup.nodo_territoriale_id) !== originNode ||
      String(dropoff.nodo_territoriale_id) !== destNode) {
    throw pixelError('PIXEL: fermate non appartenenti ai nodi territoriali richiesti');
  }

  const pickupTypes = vehicleTypes(pickup.tipi_veicolo_ammessi);
  const dropoffTypes = vehicleTypes(dropoff.tipi_veicolo_ammessi);
  const commonTypes = pickupTypes.filter(type => dropoffTypes.includes(type));
  if (commonTypes.length === 0) {
    throw pixelError('PIXEL: nessuna tipologia di veicolo compatibile fra le due fermate');
  }

  const nodesResult = await client.query(
    `SELECT id, attivo
       FROM public.nodi_territoriali
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      FOR SHARE`,
    [[originNode, destNode]]
  );
  const origin = nodesResult.rows.find(row => String(row.id) === originNode);
  const destination = nodesResult.rows.find(row => String(row.id) === destNode);
  if (!origin || !destination || origin.attivo !== true || destination.attivo !== true) {
    throw pixelError('PIXEL: nodo territoriale inesistente o non attivo');
  }

  return {
    origine_nodo_territoriale_id: originNode,
    destinazione_nodo_territoriale_id: destNode,
    origine_fermata_id: pickupId,
    destinazione_fermata_id: dropoffId,
  };
}
