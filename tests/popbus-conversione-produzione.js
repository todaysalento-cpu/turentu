// Turentu POPBUS V2 - collaudo conversione riserva -> prenotazione.
// DRY_RUN predefinito. RUN richiede autorizzazioni esplicite.
// Tutte le scritture sono nella medesima transazione, conclusa con ROLLBACK.
// Nessuna chiamata Stripe; non invoca confermaPrenotazionePopbus.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { riservaPostiPopbus } from '../services/popbus/v2/confirmed-booking.service.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';

const RUN = process.env.POPBUS_TEST_MODE === 'RUN';
const VEICOLO_ID = 347;
const CLIENTE_ID = Number(process.env.POPBUS_TEST_CLIENTE_ID || 0);
const PREFIX = `TST_POPBUS_CONVERSION_${randomUUID()}`;
const log = (...args) => console.log('[POPBUS CONVERSION]', ...args);
let client;
let transactionStarted = false;

async function prerequisites() {
  const { rows: [identity] } = await pool.query('SELECT current_database() AS db, current_user AS usr');
  log('DB:', identity.db, 'utente:', identity.usr, 'modalita:', RUN ? 'RUN' : 'DRY_RUN');
  assert.equal(identity.db, 'corse_db', 'STOP: database inatteso');
  const { rows: [vehicle] } = await pool.query(`
    SELECT v.id, v.driver_id, v.posti_totali FROM public.veicolo v
    JOIN public.utente u ON u.id = v.driver_id WHERE v.id=$1`, [VEICOLO_ID]);
  assert(vehicle && Number(vehicle.posti_totali) === 4 && Number(vehicle.driver_id) === 2,
    'Veicolo/operatore non coerenti con i dati verificati');
  const { rows: [customer] } = await pool.query('SELECT id FROM public.utente WHERE id=$1', [CLIENTE_ID]);
  assert(customer, 'Cliente test inesistente');
  if (RUN) {
    assert.equal(process.env.POPBUS_TEST_ALLOW_PRODUCTION, 'YES', 'Autorizzazione produzione mancante');
    assert.equal(process.env.POPBUS_TEST_WORKERS_STOPPED, 'YES', 'Conferma arresto worker mancante');
    assert.equal(process.env.POPBUS_TEST_BACKUP_DONE, 'YES', 'Conferma backup mancante');
  }
  log('Prerequisiti OK. Veicolo:', VEICOLO_ID, 'cliente:', CLIENTE_ID);
}

async function execute() {
  client = await pool.connect();
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '20s'");

  const start = new Date(Date.now() + 30 * 86400000);
  const end = new Date(start.getTime() + 60 * 60000);
  const { rows: [corsa] } = await client.query(`
    INSERT INTO public.corse
      (veicolo_id,start_datetime,arrivo_datetime,tipo_corsa,stato,posti_totali,
       posti_disponibili,posti_prenotati,origine_address,destinazione_address)
    VALUES ($1,$2,$3,'riempimento','prenotabile',4,4,0,$4,$4)
    RETURNING id`, [VEICOLO_ID, start, end, PREFIX]);

  const { rows: [attivazione] } = await client.query(`
    INSERT INTO public.popbus_attivazioni
      (veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,corsa_id,expires_at)
    VALUES ($1,$2,'confermata',$3,$4,0,0,0,$5::jsonb,$6,$7)
    RETURNING id`, [VEICOLO_ID, 2, start, end, JSON.stringify({ test: PREFIX }), corsa.id, end]);
  log('Fixture transazionale:', { corsaId: corsa.id, attivazioneId: attivazione.id, marker: PREFIX });

  const riserva = await riservaPostiPopbus({
    requestId: randomUUID(), corsaId: corsa.id, clienteId: CLIENTE_ID,
    postiRichiesti: 3, startOffset: 0, endOffset: 10000,
    startIndexPolyline: 0, endIndexPolyline: 1, prezzo: 1.00
  }, client);
  assert.equal(riserva.stato, 'riservata');

  const { rows: [before] } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=$1) AS prenotazioni,
      (SELECT COALESCE(SUM(posti_richiesti),0)::int FROM public.popbus_riserve
       WHERE corsa_id=$1 AND stato='riservata' AND expires_at>NOW()) AS posti_riservati`, [corsa.id]);
  assert.equal(before.prenotazioni, 0);
  assert.equal(before.posti_riservati, 3);
  log('Prima: 0 prenotazioni, 3 posti riservati');

  // Usa il vero servizio applicativo e il vero trigger PostgreSQL.
  // Il client esterno impedisce COMMIT e aggiornamenti cache nel servizio.
  const prenotazione = await prenotaCorsa(
    { id: corsa.id }, CLIENTE_ID, 3,
    { startIdx: 0, endIdx: 1, startOffset: 0, endOffset: 10000 },
    client, { popbusRiservaId: riserva.id }
  );
  assert(prenotazione?.id, 'Prenotazione non creata');

  // Simula esclusivamente la transizione DB che la conferma effettua DOPO prenotaCorsa.
  // Non simula l'autorizzazione Stripe e non prova la funzione di conferma completa.
  const updated = await client.query(`
    UPDATE public.popbus_riserve
    SET stato='confermata', prenotazione_id=$2, updated_at=NOW()
    WHERE id=$1 AND stato='riservata' RETURNING id`, [riserva.id, prenotazione.id]);
  assert.equal(updated.rowCount, 1, 'Riserva non convertita');

  const { rows: [after] } = await client.query(`
    SELECT c.posti_totali, c.posti_prenotati, c.posti_disponibili,
      (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=c.id) AS numero_prenotazioni,
      (SELECT COALESCE(SUM(posti_richiesti),0)::int FROM public.prenotazioni
       WHERE corsa_id=c.id) AS posti_prenotazioni,
      (SELECT COALESCE(SUM(posti_richiesti),0)::int FROM public.popbus_riserve
       WHERE corsa_id=c.id AND stato='riservata' AND expires_at>NOW()) AS posti_riserve_attive,
      (SELECT COUNT(*)::int FROM public.popbus_riserve
       WHERE corsa_id=c.id AND stato='confermata' AND prenotazione_id=$2) AS riserve_convertite
    FROM public.corse c WHERE c.id=$1`, [corsa.id, prenotazione.id]);
  assert.equal(Number(after.posti_totali), 4);
  assert.equal(Number(after.posti_prenotati), 3);
  assert.equal(Number(after.posti_disponibili), 1);
  assert.equal(after.numero_prenotazioni, 1);
  assert.equal(after.posti_prenotazioni, 3);
  assert.equal(after.posti_riserve_attive, 0);
  assert.equal(after.riserve_convertite, 1);
  log('PASS: 3 prenotati, 0 riservati attivi, 1 disponibile; trigger superato');
}

try {
  await prerequisites();
  if (!RUN) log('DRY_RUN OK: nessuna scrittura eseguita.');
  else await execute();
} catch (error) {
  process.exitCode = 1;
  console.error('[POPBUS CONVERSION] TEST FALLITO:', error);
} finally {
  if (client) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
        log('ROLLBACK eseguito: nessuna fixture committata.');
      } catch (error) {
        process.exitCode = 1;
        console.error('[POPBUS CONVERSION] ATTENZIONE: rollback non confermato:', error);
      }
    }
    client.release();
  }
  await pool.end();
}
