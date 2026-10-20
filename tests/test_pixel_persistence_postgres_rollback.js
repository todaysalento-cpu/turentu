// TURENTU - TEST REALE POPBUS V2 / PIXEL, SEMPRE ROLLBACK
// Posizione: tests/test_pixel_persistence_postgres_rollback.js
// Eseguire: node --env-file=.env tests\test_pixel_persistence_postgres_rollback.js
// Non avvia worker, non invia socket, non tocca Stripe.
// Richiede un'opportunita PIXEL candidata, direttrice attiva, richiesta associata,
// veicolo con driver_id valido. Se mancano: SKIP esplicito (NON PASS).
import { pool } from '../db/db.js';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';

const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
let client, tx = false, failed = false;
let passed = 0;
const pass = s => { passed++; console.log('PASS', s); };

try {
  client = await pool.connect();
  await client.query('BEGIN');
  tx = true;
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  await client.query("SET LOCAL lock_timeout = '3000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '45000ms'");

  // Verifica reale della migrazione: la colonna e la FK devono esistere.
  const schema = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='popbus_attivazione_missioni'
        AND column_name='pixel_opportunita_id' AND data_type='bigint'
    ) AS colonna,
    EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='popbus_attivazione_missioni'
        AND c.contype='f' AND pg_get_constraintdef(c.oid)
          LIKE 'FOREIGN KEY (pixel_opportunita_id) REFERENCES pixel_opportunita(id)%'
    ) AS fk
  `);
  assert(schema.rows[0].colonna && schema.rows[0].fk, 'Migrazione PIXEL missioni incompleta');
  pass('schema: colonna bigint e FK PIXEL presenti');

  // Solo dati reali; niente creazione di corridoi PIXEL nel test.
  const eligible = await client.query(`
    SELECT o.id AS opportunita_id, o.inizio_finestra, o.fine_finestra,
           d.id AS pixel_direttrice_id, d.engine_id, d.versione,
           d.nodi, d.legs, r.id AS richiesta_id,
           r.origine_nodo_territoriale_id AS origine_id,
           r.destinazione_nodo_territoriale_id AS destinazione_id,
           v.id AS veicolo_id, v.driver_id AS autista_id
    FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
    JOIN public.pixel_opportunita_richieste pr ON pr.opportunita_id=o.id
    JOIN public.richieste_pop_bus r ON r.id=pr.richiesta_id
    CROSS JOIN LATERAL (
      SELECT id, driver_id FROM public.veicolo
      WHERE driver_id IS NOT NULL ORDER BY id LIMIT 1
    ) v
    WHERE o.stato='candidata' AND d.stato='attiva'
      AND cardinality(d.nodi)>=2
      AND jsonb_typeof(d.legs)='array'
      AND jsonb_array_length(d.legs)=cardinality(d.nodi)-1
      AND r.origine_nodo_territoriale_id IS NOT NULL
      AND r.destinazione_nodo_territoriale_id IS NOT NULL
    ORDER BY o.id DESC
    LIMIT 100
  `);
  const candidate = eligible.rows.map(row => {
    const nodes = row.nodi.map(Number);
    const start = nodes.indexOf(Number(row.origine_id));
    const end = nodes.indexOf(Number(row.destinazione_id), start + 1);
    return { ...row, nodes, start, end };
  }).find(row => row.start >= 0 && row.end > row.start);
  if (!candidate) {
    console.log('SKIP: nessuna opportunita PIXEL candidata con richiesta e veicolo compatibili nei primi 100 record.');
    console.log('Il test di persistenza reale NON e stato eseguito; nessun PASS end-to-end.');
  } else {
    const c = candidate;
    // L'attivazione e solo una fixture transazionale, NON una missione fattibile/economica.
    const departure = new Date(Math.max(Date.now() + 3600000, new Date(c.inizio_finestra).getTime()));
    const arrival = new Date(departure.getTime() + 3600000);
    const expires = new Date(departure.getTime() - 60000);
    const a = await client.query(`
      INSERT INTO public.popbus_attivazioni
        (veicolo_id, autista_id, direttrice_id, pixel_opportunita_id,
         piano, partenza, arrivo, costo, ricavo, tariffa, expires_at, stato)
      VALUES ($1,$2,NULL,$3,$4::jsonb,$5,$6,0,0,0,$7,'in_attesa_autista')
      RETURNING id
    `, [c.veicolo_id, c.autista_id, c.opportunita_id,
        JSON.stringify({ test: 'PIXEL_PERSISTENCE_ROLLBACK_ONLY' }),
        departure, arrival, expires]);
    const activationId = a.rows[0].id;
    pass('attivazione temporanea con direttrice_id NULL e opportunita PIXEL');

    const mission = {
      pixelOpportunitaId: Number(c.opportunita_id),
      pixelDirettriceId: Number(c.pixel_direttrice_id),
      pixelVersione: Number(c.versione),
      corridoioPixelId: c.engine_id,
      nodes: c.nodes, legs: c.legs,
      requests: [{ id: Number(c.richiesta_id), start: c.start, end: c.end }],
      departure, arrival
    };
    const ids = await registraMissioniAttivazione(client, {
      attivazioneId: activationId, missioni: [mission]
    });
    assert(ids.length === 1, 'Numero missioni inserite inatteso');
    const check = await client.query(`
      SELECT m.id, m.pixel_opportunita_id, m.direttrice_id,
             m.corridoio_pixel_id, m.nodi_territoriali,
             mr.richiesta_id, mr.indice_salita, mr.indice_discesa
      FROM public.popbus_attivazione_missioni m
      JOIN public.popbus_missione_richieste mr ON mr.missione_id=m.id
      WHERE m.id=$1
    `, [ids[0]]);
    assert(check.rows.length === 1, 'Missione/richiesta non persistita');
    const row = check.rows[0];
    assert(String(row.pixel_opportunita_id) === String(c.opportunita_id), 'FK PIXEL errata');
    assert(row.direttrice_id === null, 'Direttrice legacy valorizzata');
    assert(row.corridoio_pixel_id === c.engine_id, 'Engine ID errato');
    assert(Number(row.richiesta_id) === Number(c.richiesta_id), 'Richiesta errata');
    assert(Number(row.indice_salita) === c.start && Number(row.indice_discesa) === c.end,
      'Indici richiesta errati');
    pass('missione PIXEL e richiesta persistite con riferimenti corretti');

    // Controllo negativo: nessuna scrittura per opportunita inesistente.
    const before = await client.query(
      'SELECT count(*)::int AS n FROM public.popbus_attivazione_missioni WHERE attivazione_id=$1',
      [activationId]);
    let rejected = false;
    try {
      await registraMissioniAttivazione(client, {
        attivazioneId: activationId,
        missioni: [{ ...mission, pixelOpportunitaId: 9223372036854775000n.toString() }]
      });
    } catch (err) {
      rejected = /non attiva|non valido|fuori intervallo|non esistente|Opportunita/i.test(err.message);
      if (!rejected) throw err;
    }
    assert(rejected, 'Opportunita inesistente non rifiutata');
    const after = await client.query(
      'SELECT count(*)::int AS n FROM public.popbus_attivazione_missioni WHERE attivazione_id=$1',
      [activationId]);
    assert(before.rows[0].n === after.rows[0].n, 'Scritture inattese su input non valido');
    pass('opportunita inesistente rifiutata senza nuove missioni');

    console.log(`RISULTATO: ${passed}/4 PASS (PostgreSQL reale, scritture solo in transazione)`);
  }
} catch (err) {
  failed = true;
  console.error('FAIL TEST PIXEL PERSISTENCE:', err?.stack || err);
  process.exitCode = 1;
} finally {
  if (client) {
    if (tx) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK CONFERMATO: nessuna modifica transazionale persistente.');
      } catch (err) {
        console.error('ERRORE ROLLBACK:', err.message);
        process.exitCode = 1;
      }
    }
    client.release();
  }
  await pool.end();
}
