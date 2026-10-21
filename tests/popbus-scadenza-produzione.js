// Turentu POPBUS V2 - test scadenza e rilascio riserve su DB reale.
// DRY_RUN di default; RUN solo con backup verificato e worker/scheduler sospesi.
// Non usa Stripe, non crea prenotazioni, non modifica servizi o schema.
// Un crash puo' lasciare fixture: conservare marker e ID stampati.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { riservaPostiPopbus, rilasciaRiservaPopbus } from '../services/popbus/v2/confirmed-booking.service.js';

const RUN = process.env.POPBUS_TEST_MODE === 'RUN';
const VEICOLO_ID = 347;
const CLIENTE_ID = Number(process.env.POPBUS_TEST_CLIENTE_ID || 0);
const MARKER = `TST_POPBUS_EXP_${randomUUID()}`;
const created = { corsa: null, attivazione: null, riserve: [] };
const requestIds = new Set();
let cleanupFailed = false;
const log = (...args) => console.log('[POPBUS EXP]', ...args);

async function prerequisites() {
  const { rows: [db] } = await pool.query('SELECT current_database() AS db, current_user AS usr');
  log('DB:', db.db, 'utente:', db.usr, 'modalita:', RUN ? 'RUN' : 'DRY_RUN');
  assert.equal(db.db, 'corse_db', 'STOP: database inatteso');
  const { rows: [v] } = await pool.query(`
    SELECT v.id,v.driver_id,v.posti_totali FROM public.veicolo v
    JOIN public.utente u ON u.id=v.driver_id WHERE v.id=$1`, [VEICOLO_ID]);
  assert(v && Number(v.posti_totali) === 4 && Number(v.driver_id) === 2, 'Veicolo non conforme');
  const { rows: [u] } = await pool.query('SELECT id FROM public.utente WHERE id=$1', [CLIENTE_ID]);
  assert(u, 'Cliente test inesistente');
  if (RUN) {
    assert.equal(process.env.POPBUS_TEST_ALLOW_PRODUCTION, 'YES', 'STOP: produzione non autorizzata');
    assert.equal(process.env.POPBUS_TEST_WORKERS_STOPPED, 'YES', 'STOP: worker non dichiarati sospesi');
    assert.equal(process.env.POPBUS_TEST_BACKUP_DONE, 'YES', 'STOP: backup non dichiarato verificato');
    assert((process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_'), 'STOP: Stripe deve essere TEST');
  }
  log('Prerequisiti OK. Veicolo:', VEICOLO_ID, 'cliente:', CLIENTE_ID);
}

async function fixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    const start = new Date(Date.now() + 30 * 86400000);
    const end = new Date(start.getTime() + 60 * 60000);
    const { rows: [c] } = await client.query(`
      INSERT INTO public.corse
        (veicolo_id,start_datetime,arrivo_datetime,tipo_corsa,stato,posti_totali,
         posti_disponibili,posti_prenotati,origine_address,destinazione_address)
      VALUES ($1,$2,$3,'riempimento','prenotabile',4,4,0,$4,$4)
      RETURNING id`, [VEICOLO_ID,start,end,MARKER]);
    created.corsa = c.id;
    const { rows: [a] } = await client.query(`
      INSERT INTO public.popbus_attivazioni
        (veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,corsa_id,expires_at)
      VALUES ($1,$2,'confermata',$3,$4,0,0,0,$5::jsonb,$6,$7)
      RETURNING id`, [VEICOLO_ID,2,start,end,JSON.stringify({test:MARKER}),c.id,end]);
    created.attivazione = a.id;
    await client.query('COMMIT');
    log('FIXTURE COMMITTED:', JSON.stringify(created), 'marker:', MARKER);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function reserve(seats) {
  const requestId = randomUUID();
  requestIds.add(requestId); // registrato prima della chiamata, anche se la risposta si perde
  const r = await riservaPostiPopbus({
    requestId, corsaId:created.corsa, clienteId:CLIENTE_ID,
    postiRichiesti:seats, startOffset:0, endOffset:10000,
    startIndexPolyline:0, endIndexPolyline:1, prezzo:1.00
  });
  created.riserve.push(r.id);
  log('Riserva:', r.id, 'posti:', seats, 'stato:', r.stato);
  return r;
}

async function inspect() {
  const { rows: [x] } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.popbus_riserve
       WHERE corsa_id=$1 AND stato='riservata' AND expires_at>NOW()) AS active_count,
      (SELECT COALESCE(SUM(posti_richiesti),0)::int FROM public.popbus_riserve
       WHERE corsa_id=$1 AND stato='riservata' AND expires_at>NOW()) AS active_seats,
      (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=$1) AS bookings,
      (SELECT COUNT(*)::int FROM public.pagamenti WHERE corsa_id=$1) AS payments`,
    [created.corsa]);
  return x;
}

async function test() {
  const first = await reserve(3);
  let state = await inspect();
  assert.equal(state.active_count, 1);
  assert.equal(state.active_seats, 3);
  log('A: riserva valida impegna 3 posti');

  // Simula 30 minuti trascorsi rispettando CHECK (expires_at > created_at).
  // Aggiorna soltanto la riserva sintetica, senza toccare schema o servizi.
  const expired = await pool.query(`
    UPDATE public.popbus_riserve
    SET created_at=NOW()-INTERVAL '31 minutes',
        expires_at=NOW()-INTERVAL '1 minute',
        updated_at=NOW()
    WHERE id=$1 AND corsa_id=$2 AND cliente_id=$3 AND request_id=$4
      AND stato='riservata' AND payment_intent_id IS NULL
      AND prenotazione_id IS NULL
    RETURNING id,created_at,expires_at`,
    [first.id,created.corsa,CLIENTE_ID,first.request_id]);
  assert.equal(expired.rowCount, 1, 'STOP: impossibile far scadere la riserva test');
  state = await inspect();
  assert.equal(state.active_count, 0);
  assert.equal(state.active_seats, 0);
  log('B: riserva scaduta esclusa dal conteggio posti');

  const second = await reserve(4); // fallisce se il servizio conta ancora la riserva scaduta
  state = await inspect();
  assert.equal(state.active_count, 1);
  assert.equal(state.active_seats, 4);
  log('C: recuperata tutta la capienza (4/4)');

  const released = await rilasciaRiservaPopbus({riservaId:second.id,clienteId:CLIENTE_ID});
  assert.equal(released.stato, 'annullata');
  const again = await rilasciaRiservaPopbus({riservaId:second.id,clienteId:CLIENTE_ID});
  assert.equal(again.stato, 'annullata');
  state = await inspect();
  assert.equal(state.active_count, 0);
  assert.equal(state.active_seats, 0);
  log('D: rilascio esplicito idempotente');

  const third = await reserve(4);
  const expiredRelease = await rilasciaRiservaPopbus({riservaId:first.id,clienteId:CLIENTE_ID,scaduta:true});
  assert.equal(expiredRelease.stato, 'scaduta');
  state = await inspect();
  assert.equal(state.active_count, 1);
  assert.equal(state.active_seats, 4);
  await rilasciaRiservaPopbus({riservaId:third.id,clienteId:CLIENTE_ID});
  state = await inspect();
  assert.deepEqual(state,{active_count:0,active_seats:0,bookings:0,payments:0});
  log('PASS: scadenza logica, recupero 4 posti, rilascio ripetuto, isolamento riserve');
}

async function cleanupDb() {
  if (!created.corsa) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    const {rows:[c]} = await client.query(`
      SELECT id FROM public.corse WHERE id=$1 AND origine_address=$2 FOR UPDATE`,
      [created.corsa,MARKER]);
    assert(c, 'STOP PULIZIA: corsa/marker non corrispondono');
    const {rows:acts} = await client.query(`
      SELECT id FROM public.popbus_attivazioni WHERE corsa_id=$1 FOR UPDATE`, [created.corsa]);
    assert.equal(acts.length,1,'STOP PULIZIA: numero attivazioni inatteso');
    assert.equal(String(acts[0].id),String(created.attivazione),'STOP PULIZIA: attivazione estranea');
    const {rows:reserves} = await client.query(`
      SELECT id,request_id,cliente_id,prenotazione_id,payment_intent_id
      FROM public.popbus_riserve WHERE corsa_id=$1 FOR UPDATE`,[created.corsa]);
    for (const r of reserves) {
      assert(requestIds.has(String(r.request_id)) && Number(r.cliente_id)===CLIENTE_ID &&
        r.prenotazione_id==null && r.payment_intent_id==null,
        'STOP PULIZIA: riserva estranea o collegata a prenotazione/pagamento');
    }
    const {rows:[counts]} = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=$1) AS bookings,
        (SELECT COUNT(*)::int FROM public.pagamenti WHERE corsa_id=$1) AS payments`,[created.corsa]);
    assert.deepEqual(counts,{bookings:0,payments:0},'STOP PULIZIA: prenotazioni/pagamenti presenti');
    for (const r of reserves) {
      const d=await client.query(`DELETE FROM public.popbus_riserve
        WHERE id=$1 AND corsa_id=$2 AND cliente_id=$3 AND request_id=$4
          AND prenotazione_id IS NULL AND payment_intent_id IS NULL RETURNING id`,
        [r.id,created.corsa,CLIENTE_ID,r.request_id]);
      assert.equal(d.rowCount,1,'Riserva non eliminata');
    }
    const a=await client.query(`DELETE FROM public.popbus_attivazioni
      WHERE id=$1 AND corsa_id=$2 RETURNING id`,[created.attivazione,created.corsa]);
    assert.equal(a.rowCount,1,'Attivazione non eliminata');
    const d=await client.query(`DELETE FROM public.corse
      WHERE id=$1 AND origine_address=$2 RETURNING id`,[created.corsa,MARKER]);
    assert.equal(d.rowCount,1,'Corsa non eliminata');
    await client.query('COMMIT');
    log('PULIZIA DB OK: corsa',created.corsa,'riserve',reserves.length);
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally {client.release();}
}

try {
  await prerequisites();
  if (!RUN) log('DRY_RUN OK: nessuna scrittura e nessuna chiamata Stripe.');
  else {await fixture();await test();}
} catch(e) {
  process.exitCode=1;
  console.error('[POPBUS EXP] TEST FALLITO:',e);
} finally {
  if (RUN) {
    try {await cleanupDb();}
    catch(e) {cleanupFailed=true;console.error('PULIZIA DB FALLITA:',e);}
    if (cleanupFailed) {
      process.exitCode=1;
      console.error('VERIFICA MANUALE NECESSARIA:',JSON.stringify(created),'marker:',MARKER);
    }
  }
  await pool.end();
}
