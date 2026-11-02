import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { leggiFormazioniPixelWorker } from '../services/popbus/v2/pixel-worker-formation-source.js';

const assert = (ok, msg) => {
  if (!ok) throw new Error('PIXEL_FIXTURE: ' + msg);
};

assert(process.env.POPBUS_PIXEL_FIRST !== '1',
  'POPBUS_PIXEL_FIRST deve essere OFF');
assert(process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'true',
  'scheduler PIXEL-first deve essere OFF');
assert(process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1',
  'LIVE_APPROVED deve essere OFF');
assert(process.env.TURENTU_PIXEL_FIXTURE_CONFIRM === 'CORSE_DB_TEST',
  'impostare TURENTU_PIXEL_FIXTURE_CONFIRM=CORSE_DB_TEST');

const NODES = [8, 5, 7];
const base = new Date(Date.now() + 14 * 86400000);
base.setUTCHours(12, 0, 0, 0);

let client;
let tx = false;

try {
  client = await pool.connect();
  await client.query('BEGIN');
  tx = true;

  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '10s'");

  const db = (await client.query(
    'SELECT current_database() AS name'
  )).rows[0].name;

  assert(db === 'corse_db', `database inatteso: ${db}`);

  const { rows } = await client.query(`
    SELECT id, nome,
           ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id = ANY($1::bigint[]) AND attivo = TRUE
  `, [NODES]);

  assert(rows.length === 3, 'nodi 8,5,7 mancanti o inattivi');

  const map = new Map(rows.map(r => [
    Number(r.id),
    { ...r, lat: Number(r.lat), lon: Number(r.lon) }
  ]));

  const road = async ids => {
    const legs = [];

    for (let i = 1; i < ids.length; i++) {
      const a = Number(ids[i - 1]);
      const b = Number(ids[i]);
      const l = await leg(map.get(a), map.get(b));

      assert(
        l && l.metres > 0 && l.seconds > 0 &&
        typeof l.polyline === 'string' && l.polyline.length,
        `routing ${a} -> ${b} non verificato`
      );

      legs.push({
        metres: l.metres,
        seconds: l.seconds,
        polyline: l.polyline,
        roadCoincident: false
      });
    }

    return { verificataRouting: true, legs };
  };

  const first = await leg(map.get(8), map.get(5));
  assert(first && first.seconds > 0,
    'routing iniziale non verificato');

  const cases = [];

  for (const minutes of [0, 45, 90, 135]) {
    const t = base.getTime() + minutes * 60000;

    cases.push(
      { a: 8, b: 5, at: new Date(t), prezzo: 7 },
      {
        a: 5, b: 7,
        at: new Date(t + Math.round(first.seconds) * 1000),
        prezzo: 9
      },
      { a: 8, b: 7, at: new Date(t), prezzo: 14 }
    );
  }

  const ids = [];

  for (const c of cases) {
    const a = map.get(c.a);
    const b = map.get(c.b);

    const r = await client.query(`
      INSERT INTO public.richieste_pop_bus
      (
        origine, destinazione,
        origine_nodo_territoriale_id,
        destinazione_nodo_territoriale_id,
        origine_address, destinazione_address,
        start_datetime, posti_richiesti,
        stato, classe, prezzo
      )
      VALUES (
        ST_SetSRID(ST_MakePoint($1,$2),4326),
        ST_SetSRID(ST_MakePoint($3,$4),4326),
        $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10
      )
      RETURNING id
    `, [
      a.lon, a.lat, b.lon, b.lat,
      c.a, c.b, a.nome, b.nome, c.at, c.prezzo
    ]);

    ids.push(Number(r.rows[0].id));
  }

  assert(ids.length === 12, 'richieste sintetiche incomplete');

  const requests = (await client.query(`
    SELECT *
    FROM public.richieste_pop_bus
    WHERE id = ANY($1::int[])
    ORDER BY id
  `, [ids])).rows;

  const engine = createIncrementalCorridorEngine({
    routeNodes: road,
    abilitaVariantiP1: true
  });

  for (const r of requests) {
    await engine.processRequest(r);
  }

  const corridors = engine.listCorridors();

  assert(
    corridors.some(c => c.nodes.join('>') === '8>5>7'),
    'PIXEL non ha generato la direttrice composta'
  );

  for (const c of corridors) {
    await pubblicaOpportunitaPixel({
      engine,
      direttriceId: c.id,
      bufferMinuti: 0,
      client
    });
  }

  // Individua soltanto le opportunita associate alla fixture.
  const { rows: associations } = await client.query(`
    SELECT por.opportunita_id, por.richiesta_id
    FROM public.pixel_opportunita_richieste por
    WHERE por.opportunita_id IN (
      SELECT opportunita_id
      FROM public.pixel_opportunita_richieste
      WHERE richiesta_id = ANY($1::int[])
    )
  `, [ids]);

  const fixtureIds = new Set(ids);
  const opportunityIds = [
    ...new Set(associations.map(r => Number(r.opportunita_id)))
  ];

  assert(opportunityIds.length > 0,
    'nessuna opportunita associata alla fixture');

  assert(
    associations.every(r => fixtureIds.has(Number(r.richiesta_id))),
    'opportunita contaminata da richieste precedenti'
  );

  const represented = new Set(
    associations.map(r => Number(r.richiesta_id))
  );

  assert(
    ids.every(id => represented.has(id)),
    'alcune richieste non sono rappresentate da PIXEL'
  );

  const { rows: opportunities } = await client.query(`
    SELECT id, stato
    FROM public.pixel_opportunita
    WHERE id = ANY($1::int[])
  `, [opportunityIds]);

  assert(
    opportunities.length === opportunityIds.length &&
    opportunities.every(o => o.stato === 'candidata'),
    'opportunita fixture non tutte candidate'
  );

  const formazioni = await leggiFormazioniPixelWorker({
    client,
    limit: 1000,
    maxFormazioniPerSeed: 80
  });

  const fixtureFormazioni = formazioni.filter(f =>
    f.richiestaIds.some(id => fixtureIds.has(Number(id)))
  );

  assert(fixtureFormazioni.length > 0,
    'nessuna formazione PIXEL per la fixture');

  assert(
    fixtureFormazioni.every(f =>
      f.source === 'PIXEL' &&
      f.richiestaIds.every(id => fixtureIds.has(Number(id)))
    ),
    'formazioni contaminate da richieste precedenti'
  );

  console.log('PIXEL_FIXTURE_PRECOMMIT_JSON:' + JSON.stringify({
    db,
    partenzaUTC: base.toISOString(),
    richieste: ids.length,
    richiestaIds: ids,
    opportunitaIds: opportunityIds,
    formazioni: fixtureFormazioni.length
  }));

  await client.query('COMMIT');
  tx = false;

  console.log('PIXEL_FIXTURE_COMMIT_OK');

} catch (e) {
  console.error('PIXEL_FIXTURE_ERRORE:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (tx) {
      try {
        await client.query('ROLLBACK');
        console.log('PIXEL_FIXTURE_ROLLBACK_OK');
      } catch (e) {
        console.error('ROLLBACK_FALLITO:', e.message);
        process.exitCode = 1;
      }
    }
    client.release();
  }
  await pool.end();
}