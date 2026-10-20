// TURENTU - TEST INTEGRAZIONE PIXEL/POPBUS V2 CON FIXTURE TRANSITORIA
// Salva come tests/test_pixel_persistence_fixture_rollback.js
// node --env-file=.env tests\test_pixel_persistence_fixture_rollback.js
// NON avvia worker / Stripe / socket. SEMPRE ROLLBACK. Non usare su produzione in esercizio.
import { pool } from '../db/db.js';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';

const ok = (condition, message) => { if (!condition) throw new Error(message); };
const log = message => console.log('PASS', message);
let client, began = false, passes = 0;
const passed = message => { passes++; log(message); };
try {
  client = await pool.connect();
  await client.query('BEGIN');
  began = true;
  await client.query("SET LOCAL lock_timeout = '3000ms'");
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '60000ms'");

  // Riutilizziamo soltanto un veicolo esistente. La richiesta viene creata
  // appositamente dentro la transazione, senza FK verso utenti o corse.
  const v = await client.query(
    'SELECT id, driver_id FROM public.veicolo WHERE driver_id IS NOT NULL ORDER BY id LIMIT 1'
  );
  if (!v.rows.length) {
    console.log('SKIP: nessun veicolo con driver_id nel database.');
  } else {
    const vehicle = v.rows[0];
    const richiesta = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (cliente_id, origine, destinazione, start_datetime, posti_richiesti,
         stato, classe, origine_address, destinazione_address, prezzo)
      VALUES
        (NULL, NULL, NULL, now() + interval '2 hours', 1,
         'in_attesa', 'STANDARD', 'TEST PIXEL origine', 'TEST PIXEL destinazione', 0)
      RETURNING id
    `);
    const requestId = richiesta.rows[0].id;
    passed('richiesta passeggero artificiale creata nella transazione');
    // Nodi fittizi usati SOLO per verificare la persistenza, non il routing.
    // Non vengono inseriti in nodi_territoriali, non rappresentano una corsa reale.
    const nodes = [900000001, 900000002];
    const legs = [{ metres: 1000, seconds: 120, polyline: '', roadCoincident: true }];
    const engineId = 'PIXEL_TEST_ROLLBACK_' + process.pid + '_' + Date.now();
    const start = new Date(Date.now() + 2 * 3600000);
    const end = new Date(start.getTime() + 20 * 60000);

    const d = await client.query(`
      INSERT INTO public.pixel_direttrici(engine_id, versione, nodi, legs, stato)
      VALUES ($1,1,$2::bigint[],$3::jsonb,'attiva') RETURNING id
    `, [engineId, nodes, JSON.stringify(legs)]);
    const corridorId = d.rows[0].id;
    const o = await client.query(`
      INSERT INTO public.pixel_opportunita
        (direttrice_id, inizio_finestra, fine_finestra, dati_temporali, stato)
      VALUES ($1,$2,$3,$4::jsonb,'candidata') RETURNING id
    `, [corridorId, start, end, JSON.stringify({ testOnly: true })]);
    const opportunityId = o.rows[0].id;
    await client.query(`
      INSERT INTO public.pixel_opportunita_richieste(opportunita_id, richiesta_id)
      VALUES ($1,$2)
    `, [opportunityId, requestId]);
    passed('fixture PIXEL creata con richiesta artificiale associata');

    const a = await client.query(`
      INSERT INTO public.popbus_attivazioni
        (veicolo_id, autista_id, direttrice_id, pixel_opportunita_id,
         piano, partenza, arrivo, costo, ricavo, tariffa, expires_at, stato)
      VALUES ($1,$2,NULL,$3,$4::jsonb,$5,$6,0,0,0,$7,'in_attesa_autista')
      RETURNING id
    `, [vehicle.id, vehicle.driver_id, opportunityId,
        JSON.stringify({ testOnly: true, source: 'fixture_rollback' }),
        start, end, new Date(start.getTime() - 60000)]);
    const activationId = a.rows[0].id;
    passed('attivazione temporanea PIXEL senza direttrice legacy');

    const mission = {
      pixelOpportunitaId: opportunityId,
      pixelDirettriceId: corridorId,
      pixelVersione: 1,
      corridoioPixelId: engineId,
      nodes, legs, requests: [{ id: requestId, start: 0, end: 1 }],
      departure: start, arrival: end
    };
    const ids = await registraMissioniAttivazione(client, {
      attivazioneId: activationId, missioni: [mission]
    });
    ok(Array.isArray(ids) && ids.length === 1, 'Il modulo non ha restituito una missione');
    const check = await client.query(`
      SELECT m.pixel_opportunita_id, m.direttrice_id, m.corridoio_pixel_id,
             mr.richiesta_id, mr.indice_salita, mr.indice_discesa
      FROM public.popbus_attivazione_missioni m
      JOIN public.popbus_missione_richieste mr ON mr.missione_id=m.id
      WHERE m.id=$1
    `, [ids[0]]);
    ok(check.rows.length === 1, 'Missione/richiesta non trovata');
    const row = check.rows[0];
    ok(String(row.pixel_opportunita_id) === String(opportunityId), 'FK opportunita errata');
    ok(row.direttrice_id === null, 'Direttrice legacy non NULL');
    ok(row.corridoio_pixel_id === engineId, 'Engine ID errato');
    ok(String(row.richiesta_id) === String(requestId), 'Richiesta errata');
    ok(Number(row.indice_salita) === 0 && Number(row.indice_discesa) === 1, 'Indici errati');
    passed('missione e richiesta persistite correttamente su PostgreSQL reale');

    // Negativo senza SQL che abortisce la transazione: stessa opportunita,
    // ma nodi discordanti, prevalidazione senza INSERT.
    let rejected = false;
    try {
      await registraMissioniAttivazione(client, {
        attivazioneId: activationId,
        missioni: [{ ...mission, nodes: [900000001, 900000003] }]
      });
    } catch (e) {
      rejected = /sequenza nodi discordante/i.test(e.message);
      if (!rejected) throw e;
    }
    ok(rejected, 'Nodi discordanti non rifiutati');
    const count = await client.query(
      'SELECT count(*)::int AS n FROM public.popbus_attivazione_missioni WHERE attivazione_id=$1',
      [activationId]);
    ok(count.rows[0].n === 1, 'Una missione non valida ha causato scritture');
    passed('nodi discordanti rifiutati senza scritture aggiuntive');

    // Negativo su stato opportunita: UPDATE temporaneo e controllo applicativo.
    await client.query("UPDATE public.pixel_opportunita SET stato='superata' WHERE id=$1", [opportunityId]);
    rejected = false;
    try {
      await registraMissioniAttivazione(client, {
        attivazioneId: activationId, missioni: [mission]
      });
    } catch (e) {
      rejected = /non attiva\/candidata/i.test(e.message);
      if (!rejected) throw e;
    }
    ok(rejected, 'Opportunita superata non rifiutata');
    passed('opportunita superata rifiutata');

    console.log(`RISULTATO: ${passes}/6 PASS - fixture transazionale; NON test routing, economia o worker`);
  }
} catch (err) {
  console.error('FAIL:', err?.stack || err);
  process.exitCode = 1;
} finally {
  if (client) {
    if (began) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK COMPLETATO: richiesta, fixture PIXEL e attivazioni non persistite.');
      } catch (err) {
        console.error('ERRORE ROLLBACK:', err);
        process.exitCode = 1;
      }
    }
    client.release();
  }
  await pool.end();
}
