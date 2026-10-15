// TURENTU POPBUS + PIXEL — collaudo reale PostgreSQL in sola lettura.
// Posizione: tests/test_pixel_render_readonly.mjs
// Non crea richieste, non usa Stripe, non modifica wallet o fermate.
// Usa la configurazione DB del progetto: CONTROLLARE che punti al DB Render previsto.
import 'dotenv/config';
import { pool } from '../db/db.js';
import { validatePixelStops } from '../services/pixel/pixel.validation.service.js';

const EXPECTED_ERROR = (status, label) => async (fn) => {
  try {
    await fn();
    throw new Error(`${label}: ERRORE: il validatore ha accettato dati non validi`);
  } catch (err) {
    if (err.status !== status) throw new Error(`${label}: atteso HTTP ${status}, ottenuto ${err.status ?? 'errore tecnico'}: ${err.message}`);
    console.log(`PASS ${label} (HTTP ${status})`);
  }
};
const popSlot = (extra = {}) => ({
  id: 'virtual_pop_pending_standard',
  tipo: 'pop-bus',
  origine_nodo_territoriale_id: 6,
  destinazione_nodo_territoriale_id: 8,
  ...extra,
});

let client;
let begun = false;
try {
  client = await pool.connect();
  // READ ONLY: PostgreSQL rifiuta qualunque INSERT/UPDATE/DELETE in questa transazione.
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  begun = true;
  const db = await client.query(`SELECT current_database() AS db, current_user AS db_user,
    inet_server_addr()::text AS server_ip, pg_is_in_recovery() AS replica`);
  console.log('DB collegato (verificare che sia Render):', db.rows[0]);

  const counts = await client.query(`SELECT
    (SELECT count(*)::int FROM public.richieste_pop_bus) AS richieste_totali,
    (SELECT count(*)::int FROM public.richieste_pop_bus WHERE origine_fermata_id IS NOT NULL OR destinazione_fermata_id IS NOT NULL) AS richieste_pixel,
    (SELECT count(*)::int FROM public.transazioni_wallet) AS transazioni_wallet,
    (SELECT count(*)::int FROM public.pixel_fermate WHERE attiva AND verificata) AS fermate_attive_verificate`);
  console.log('Stato iniziale:', counts.rows[0]);

  // Questo test verifica un rifiuto prima di qualunque query sulle fermate.
  await EXPECTED_ERROR(422, 'POPBUS senza fermate PIXEL')(async () => {
    await validatePixelStops(client, popSlot(), null);
  });
  await EXPECTED_ERROR(422, 'POPBUS con fermate identiche')(async () => {
    await validatePixelStops(client, popSlot({ origine_fermata_id: 1, destinazione_fermata_id: 1 }), null);
  });
  await EXPECTED_ERROR(409, 'Preventivo con PIXEL indisponibile')(async () => {
    await validatePixelStops(client,
      popSlot({ origine_fermata_id: 1, destinazione_fermata_id: 2 }),
      { origine_nodo_territoriale_id: 6, destinazione_nodo_territoriale_id: 8, pixel_fermate_disponibili: false });
  });

  // Verifica sul DB reale: se non ci sono fermate attive, non inventiamo fermate.
  const pair = await client.query(`SELECT a.id AS pickup_id, b.id AS dropoff_id,
       a.nodo_territoriale_id AS origin_node, b.nodo_territoriale_id AS dest_node
    FROM public.pixel_fermate a
    JOIN public.pixel_fermate b ON b.id <> a.id
    JOIN public.nodi_territoriali na ON na.id = a.nodo_territoriale_id AND na.attivo
    JOIN public.nodi_territoriali nb ON nb.id = b.nodo_territoriale_id AND nb.attivo
    WHERE a.attiva AND a.verificata AND b.attiva AND b.verificata
      AND a.nodo_territoriale_id <> b.nodo_territoriale_id
      AND a.tipi_veicolo_ammessi && b.tipi_veicolo_ammessi
    LIMIT 1`);
  if (pair.rows.length) {
    const p = pair.rows[0];
    const slot = popSlot({ origine_fermata_id: p.pickup_id, destinazione_fermata_id: p.dropoff_id,
      origine_nodo_territoriale_id: p.origin_node, destinazione_nodo_territoriale_id: p.dest_node });
    const quotation = { origine_nodo_territoriale_id: p.origin_node,
      destinazione_nodo_territoriale_id: p.dest_node, pixel_fermate_disponibili: true };
    const validated = await validatePixelStops(client, slot, quotation);
    if (!validated || String(validated.origine_fermata_id) !== String(p.pickup_id)) throw new Error('Validazione coppia reale inattesa');
    console.log('PASS coppia reale attiva/verificata/compatibile (solo lettura)');
  } else {
    console.log('SKIP coppia reale valida: nessuna coppia disponibile nel DB (non viene creata)');
  }

  const after = await client.query(`SELECT
    (SELECT count(*)::int FROM public.richieste_pop_bus) AS richieste_totali,
    (SELECT count(*)::int FROM public.richieste_pop_bus WHERE origine_fermata_id IS NOT NULL OR destinazione_fermata_id IS NOT NULL) AS richieste_pixel,
    (SELECT count(*)::int FROM public.transazioni_wallet) AS transazioni_wallet,
    (SELECT count(*)::int FROM public.pixel_fermate WHERE attiva AND verificata) AS fermate_attive_verificate`);
  if (JSON.stringify(after.rows[0]) !== JSON.stringify(counts.rows[0])) throw new Error('Conteggi diversi nella stessa snapshot read-only');
  console.log('PASS conteggi invariati nella snapshot read-only');
  console.log('COLLAUDO TERMINATO: nessuna scrittura effettuata dallo script.');
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (begun) {
      try { await client.query('ROLLBACK'); } catch (err) { console.error('ROLLBACK:', err.message); process.exitCode = 1; }
    }
    client.release();
  }
  await pool.end();
}
