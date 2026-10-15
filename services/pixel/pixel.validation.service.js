// PIXEL: validazione server-side condivisa dai percorsi Stripe e wallet.
// Usare il client della transazione corrente. Fail closed se lo schema non e' riconosciuto.
const integerId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function isPopbusSlot(slot) {
  const kind = String(slot?.tipo ?? slot?.tipo_corsa ?? '').toLowerCase().replace(/[-_\s]/g, '');
  const id = String(slot?.id ?? '');
  return kind === 'popbus' || id.startsWith('virtual_pop_') || id.startsWith('dir_') || id === 'nuova_proposta';
}

export async function validatePixelStops(client, slot, quotation = null) {
  if (!isPopbusSlot(slot)) return null;
  const pickupId = integerId(slot.origine_fermata_id);
  const dropoffId = integerId(slot.destinazione_fermata_id);
  const originNode = integerId(slot.origine_nodo_territoriale_id);
  const destNode = integerId(slot.destinazione_nodo_territoriale_id);
  if (!pickupId || !dropoffId || !originNode || !destNode || pickupId === dropoffId) {
    const error = new Error('PIXEL: fermate e nodi territoriali obbligatori'); error.status = 422; throw error;
  }
  if (quotation && (
    Number(quotation.origine_nodo_territoriale_id) !== originNode ||
    Number(quotation.destinazione_nodo_territoriale_id) !== destNode ||
    quotation.pixel_fermate_disponibili !== true
  )) {
    const error = new Error('PIXEL: fermate non disponibili per questa ricerca'); error.status = 409; throw error;
  }
  // Nomi di colonna individuati dal catalogo; nessun bypass se mancano verifiche.
  const columns = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pixel_fermate'`);
  const names = new Set(columns.rows.map(r => r.column_name));
  const choose = (...options) => options.find(n => names.has(n));
  const nodeCol = choose('nodo_territoriale_id', 'nodo_id');
  const activeCol = choose('attiva', 'attivo', 'is_active', 'active');
  const verifiedCol = choose('verificata', 'verificato', 'is_verified', 'verified');
  const vehicleCol = choose('tipi_veicolo_ammessi');
  if (!nodeCol || !activeCol || !verifiedCol || !vehicleCol) {
    const error = new Error('PIXEL: schema fermate non verificabile; operazione bloccata'); error.status = 503; throw error;
  }
  const result = await client.query(`SELECT id, "${nodeCol}" AS nodo_id,
    "${activeCol}" AS attiva, "${verifiedCol}" AS verificata,
    "${vehicleCol}" AS tipi_veicolo_ammessi
    FROM public.pixel_fermate WHERE id = ANY($1::int[]) FOR SHARE`, [[pickupId, dropoffId]]);
  const pickup = result.rows.find(r => Number(r.id) === pickupId);
  const dropoff = result.rows.find(r => Number(r.id) === dropoffId);
  const types = v => Array.isArray(v) ? v : (typeof v === 'string' && v.startsWith('{') ? v.slice(1,-1).split(',') : []);
  if (!pickup || !dropoff || pickup.attiva !== true || dropoff.attiva !== true ||
      pickup.verificata !== true || dropoff.verificata !== true ||
      Number(pickup.nodo_id) !== originNode || Number(dropoff.nodo_id) !== destNode ||
      !types(pickup.tipi_veicolo_ammessi).some(t => types(dropoff.tipi_veicolo_ammessi).includes(t))) {
    const error = new Error('PIXEL: fermate non attive, non verificate o incompatibili'); error.status = 422; throw error;
  }
  return { origine_nodo_territoriale_id: originNode,
    destinazione_nodo_territoriale_id: destNode,
    origine_fermata_id: pickupId, destinazione_fermata_id: dropoffId };
}
