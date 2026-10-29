/**
 * TURENTU STEP 4.36 - concorrenza reale A/R con fixture COMMIT e pulizia.
 * SOLO DATABASE DI COLLAUDO. Richiede TURENTU_TEST_DB_OK=SI.
 * NON usare su produzione: esegue COMMIT di dati di prova e DELETE finale.
 * Non chiama Stripe, non modifica i servizi.
 * Obiettivo: A accetta, B incontra il lock, poi B rifiutata per conflitto.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { accettaTrattaARAtomica } from '../services/booking/ar-atomic-acceptance.service.js';

if (process.env.TURENTU_TEST_DB_OK !== 'SI') {
  console.error('BLOCCATO: imposta TURENTU_TEST_DB_OK=SI solo sul database di collaudo.');
  process.exitCode = 1;
} else {
  const marker = `TURENTU_436_${randomUUID().slice(0, 8)}`;
  const groupIds = [randomUUID(), randomUUID()];
  const ids = { vehicle: null, pending: [] };
  const movement = async () => ({ metres: 100, seconds: 60 });
  let a, b, setup, passed = 0, failed = false;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const logPass = msg => { passed++; console.log(`PASS ${passed}: ${msg}`); };

  async function tx(client, timeout = '5000ms') {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${timeout}'`);
    await client.query("SET LOCAL statement_timeout = '12000ms'");
  }

  async function cleanup() {
    // Solo ID creati da questo script, mai DELETE indiscriminati.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (ids.pending.length) {
        await c.query('DELETE FROM ar_accettazioni WHERE pending_id = ANY($1::integer[])', [ids.pending]);
        await c.query('DELETE FROM pending WHERE id = ANY($1::integer[])', [ids.pending]);
      }
      await c.query('DELETE FROM ar_gruppi WHERE id = ANY($1::uuid[])', [groupIds]);
      if (ids.vehicle !== null) {
        await c.query('DELETE FROM disponibilita_veicolo WHERE veicolo_id = $1', [ids.vehicle]);
        await c.query('DELETE FROM veicolo WHERE id = $1 AND modello = $2', [ids.vehicle, marker]);
      }
      await c.query('COMMIT');
      console.log('Pulizia dati di collaudo: COMMIT eseguito');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  try {
    setup = await pool.connect();
    // Le fixture DEVONO essere confermate per essere visibili a entrambe le connessioni.
    await tx(setup);
    const { rows: owners } = await setup.query(`
      SELECT driver_id FROM veicolo WHERE driver_id IS NOT NULL ORDER BY id LIMIT 1`);
    const { rows: customers } = await setup.query('SELECT id FROM utente ORDER BY id LIMIT 1');
    assert(owners.length && customers.length, 'Servono un operatore e un cliente di collaudo');
    const operatorId = Number(owners[0].driver_id);
    const customerId = customers[0].id;

    const { rows: vehicles } = await setup.query(`
      INSERT INTO veicolo (driver_id, modello, posti_totali, stato)
      VALUES ($1, $2, 8, 'test') RETURNING id`, [operatorId, marker]);
    ids.vehicle = vehicles[0].id;

    await setup.query(`
      INSERT INTO disponibilita_veicolo
        (veicolo_id, start, fine, manual, giorni_esclusi, inattivita)
      VALUES ($1, '2026-01-01T08:00:00+01'::timestamptz,
        '2026-01-01T16:00:00+01'::timestamptz,
        FALSE, ARRAY[]::integer[], '[]'::jsonb)`, [ids.vehicle]);

    for (const gid of groupIds) {
      await setup.query(`INSERT INTO ar_gruppi (id, cliente_id, stato, expires_at)
        VALUES ($1,$2,'in_attesa',NOW()+INTERVAL '30 minutes')`, [gid, customerId]);
      const { rows } = await setup.query(`
        INSERT INTO pending (
          veicolo_id, cliente_id, start_datetime, durata, posti_richiesti,
          tipo_corsa, expires_at, stato, ar_group_id, ar_tratta,
          ar_vincolata, origine, destinazione
        ) VALUES (
          $1,$2,'2032-01-14T10:00:00Z'::timestamptz,
          INTERVAL '60 minutes',1,'privata',NOW()+INTERVAL '30 minutes',
          'pending',$3,'andata',TRUE,
          ST_SetSRID(ST_MakePoint(18.174966,40.3515255),4326)::geography,
          ST_SetSRID(ST_MakePoint(17.2348,40.4674),4326)::geography
        ) RETURNING id`, [ids.vehicle, customerId, gid]);
      ids.pending.push(rows[0].id);
    }
    await setup.query('COMMIT');
    setup.release(); setup = null;
    console.log(`Fixture confermate: veicolo ${ids.vehicle}; pending ${ids.pending.join(', ')}`);

    a = await pool.connect();
    b = await pool.connect();
    await tx(a, '5000ms');
    await tx(b, '600ms');

    // A accetta e mantiene il lock sul veicolo SENZA committare.
    const accepted = await accettaTrattaARAtomica({
      pendingId: ids.pending[0], operatoreId: operatorId, client: a, movement
    });
    assert(accepted.stato === 'provvisoria', 'A non ha creato la riserva');
    logPass('A crea riserva provvisoria e mantiene il lock');

    // B tenta veramente in parallelo mentre A detiene il lock.
    let blocked;
    try {
      await accettaTrattaARAtomica({
        pendingId: ids.pending[1], operatoreId: operatorId, client: b, movement
      });
    } catch (e) { blocked = e; }
    assert(blocked?.code === '55P03',
      `B doveva attendere il lock (55P03), ottenuto: ${blocked?.code ?? 'SUCCESS'}`);
    await b.query('ROLLBACK');
    logPass('B non puo accettare mentre A mantiene il lock');

    await a.query('COMMIT');
    logPass('A conferma la riserva provvisoria');

    // Dopo il commit A, B rivalida e deve vedere il conflitto.
    await tx(b, '3000ms');
    let conflict;
    try {
      await accettaTrattaARAtomica({
        pendingId: ids.pending[1], operatoreId: operatorId, client: b, movement
      });
    } catch (e) { conflict = e; }
    assert(conflict?.code === 'AR_VEHICLE_CONFLICT',
      `Atteso AR_VEHICLE_CONFLICT, ottenuto ${conflict?.code ?? 'SUCCESS'}`);
    await b.query('ROLLBACK');
    logPass('B rivalida dopo COMMIT A e rifiuta il conflitto');

    const { rows: counts } = await pool.query(`
      SELECT pending_id FROM ar_accettazioni
      WHERE pending_id = ANY($1::integer[]) AND stato = 'provvisoria'
      ORDER BY pending_id`, [ids.pending]);
    assert(counts.length === 1 && Number(counts[0].pending_id) === Number(ids.pending[0]),
      'Doppia riserva rilevata');
    logPass('Una sola accettazione persistita prima della pulizia');
  } catch (e) {
    failed = true;
    console.error('TEST FALLITO:', e.code ?? e.message, e);
  } finally {
    for (const c of [a, b, setup]) {
      if (!c) continue;
      try { await c.query('ROLLBACK'); } catch (_) {}
      c.release();
    }
    try {
      await cleanup();
      const { rows: residual } = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM veicolo WHERE id=$1 AND modello=$2) AS veicoli,
          (SELECT count(*)::int FROM pending WHERE id=ANY($3::integer[])) AS pending,
          (SELECT count(*)::int FROM ar_gruppi WHERE id=ANY($4::uuid[])) AS gruppi,
          (SELECT count(*)::int FROM ar_accettazioni WHERE pending_id=ANY($3::integer[])) AS accettazioni`,
        [ids.vehicle, marker, ids.pending, groupIds]);
      assert(Object.values(residual[0]).every(v => Number(v) === 0),
        `Dati residui: ${JSON.stringify(residual[0])}`);
      logPass('Pulizia verificata: nessun dato residuo');
    } catch (e) {
      failed = true;
      console.error('ATTENZIONE: pulizia/verifica fallita, controllare il DB:', e);
      console.error('ID per pulizia manuale:', { marker, groupIds, ...ids });
    }
    await pool.end();
  }
  console.log(`Risultato: ${passed}/6 test superati`);
  if (failed || passed !== 6) process.exitCode = 1;
}
