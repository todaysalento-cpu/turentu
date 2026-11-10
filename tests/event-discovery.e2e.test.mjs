import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { test } from 'node:test';

test('workflow Admin, PostgreSQL e PostGIS con fonti simulate', { skip: !process.env.EVENT_DISCOVERY_TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.EVENT_DISCOVERY_TEST_DATABASE_URL);
  assert.equal(testUrl.hostname, '127.0.0.1');
  assert.equal(testUrl.pathname, '/event_discovery_test');
  assert.equal(testUrl.port, '55439');
  process.env.DATABASE_URL = testUrl.href;
  process.env.DATABASE_SSL_MODE = 'disable';
  process.env.JWT_SECRET = 'discovery-e2e-generated-only';
  for (const flag of ['ENABLED', 'MONITOR', 'SEARCH', 'GEO']) process.env['EVENT_DISCOVERY_' + flag] = 'true';
  for (const permission of ['SOURCES', 'ACQUIRE', 'REVIEW', 'PUBLISH', 'CONFIGURE']) process.env['EVENT_DISCOVERY_' + permission + '_USERS'] = '7';
  process.env.EVENT_DISCOVERY_BRAVE_KEY = 'simulated-key';
  process.env.EVENT_DISCOVERY_GEOCODER_URL = 'https://geo.example.org/search';
  delete process.env.EVENT_DISCOVERY_BRAVE_STORAGE_AUTHORIZED;

  const { default: express } = await import('express');
  const { default: jwt } = await import('jsonwebtoken');
  const { pool } = await import('../db/db.js');
  const { authMiddleware, requireRole } = await import('../middleware/auth.js');
  const { createDiscovery } = await import('../services/event-discovery/service.js');
  const { createEventDiscoveryRouter } = await import('../routes/admin/event-discovery.routes.js');
  t.after(() => pool.end());
  assert.equal((await pool.query("SELECT to_regclass('public.eventi') AS existing")).rows[0].existing, null,
    'Il database di test deve essere vuoto');
  await pool.query(`
    CREATE EXTENSION postgis;
    CREATE TABLE eventi (id serial PRIMARY KEY, titolo varchar NOT NULL, categoria varchar NOT NULL,
      descrizione text, data_inizio timestamptz NOT NULL, data_fine timestamptz, luogo_nome varchar NOT NULL,
      indirizzo text, citta varchar, lat double precision, lng double precision, creato_da integer,
      created_at timestamptz DEFAULT now(), immagine_url text, stato varchar DEFAULT 'in_attesa');
    CREATE TABLE corse (id serial PRIMARY KEY, evento_id int REFERENCES eventi ON DELETE SET NULL);
    CREATE TABLE richieste_pop_bus (id serial PRIMARY KEY, evento_id int REFERENCES eventi ON DELETE RESTRICT);
    CREATE TABLE nodi_territoriali (id bigint PRIMARY KEY, nome varchar, posizione geography(Point,4326), attivo boolean);
    CREATE TABLE pixel_fermate (id bigint PRIMARY KEY, nodo_territoriale_id bigint REFERENCES nodi_territoriali,
      posizione geography(Point,4326), attiva boolean, verificata boolean);
    INSERT INTO nodi_territoriali VALUES (1,'Lecce',ST_SetSRID(ST_MakePoint(18.17,40.35),4326),true);
    INSERT INTO pixel_fermate VALUES (2,1,ST_SetSRID(ST_MakePoint(18.17,40.35),4326),true,true);
  `);
  await pool.query(await readFile(new URL('../migrations/006_event_discovery.sql', import.meta.url), 'utf8'));

  const item = { id: 'official-1', title: 'Concerto', category: 'musica', start: '2026-11-21T20:00:00Z',
    venue: 'Teatro', city: 'Lecce', address: 'Via Roma 1', url: 'https://official.example.org/concerto' };
  let feed = [item];
  let networkError = false;
  let cache = false;
  let pending;
  const service = createDiscovery(pool, {
    now: () => new Date('2026-11-10T12:00:00Z'),
    read: async (url, headers) => {
      if (url.startsWith('https://geo.example.org/')) {
        assert.equal(new URL(url).searchParams.get('street'), 'Via Roma 1');
        return { body: JSON.stringify([{ lat: '40.35', lon: '18.17', place_rank: 30,
          address: { city: 'Lecce', country_code: 'it', road: 'Via Roma', house_number: '1' } }]) };
      }
      if (url.startsWith('https://api.search.brave.com/')) {
        assert.equal(headers['X-Subscription-Token'], 'simulated-key');
        assert.match(new URL(url).searchParams.get('q'), /concerti Lecce/);
        return { body: '{"web":{"results":[{"url":"https://official.example.org/concerto"}]}}' };
      }
      if (url.endsWith('robots.txt')) return { body: 'User-agent: *' };
      if (networkError) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      if (pending) await pending;
      if (cache) {
        assert.equal(headers['If-None-Match'], '"v1"');
        return { status: 304, headers: {} };
      }
      return { status: 200, headers: { etag: '"v1"' }, body: JSON.stringify(feed) };
    },
  });
  const app = express();
  app.use(express.json(), authMiddleware, requireRole('Admin', 'admin'), createEventDiscoveryRouter(pool, service));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const tokens = {
    admin: jwt.sign({ id: 7, role: 'Admin' }, process.env.JWT_SECRET),
    read: jwt.sign({ id: 8, role: 'Admin' }, process.env.JWT_SECRET),
    client: jwt.sign({ id: 7, role: 'Cliente' }, process.env.JWT_SECRET),
  };
  async function api(path, { actor = 'admin', method = 'GET', body, status = 200, header = true } = {}) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method, headers: { ...(actor ? { Authorization: 'Bearer ' + tokens[actor] } : {}),
        ...(method !== 'GET' ? { 'Content-Type': 'application/json', ...(header ? { 'X-Event-Discovery': '1' } : {}) } : {}) },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  await api('/', { actor: null, status: 401 });
  await api('/', { actor: 'client', status: 403 });
  await api('/sources', { actor: 'read', method: 'POST', status: 403 });
  await api('/sources', { method: 'POST', header: false, status: 415 });
  process.env.EVENT_DISCOVERY_ENABLED = 'false';
  await api('/', { status: 404 });
  process.env.EVENT_DISCOVERY_ENABLED = 'true';
  await api('/settings', { method: 'PUT', body: { radiusKm: 5 } });
  assert.equal((await api('/settings')).radiusKm, 5);

  const search = { method: 'POST', body: { territories: ['Lecce'], categories: ['concerti'] } };
  assert.deepEqual((await api('/discover', search)).urls, [item.url]);
  assert.equal((await api('/sources')).length, 0);
  process.env.EVENT_DISCOVERY_BRAVE_STORAGE_AUTHORIZED = 'true';
  assert.equal((await api('/discover', search)).count, 1);
  assert.equal((await api('/sources'))[0].state, 'candidata');
  await api('/sources', { method: 'POST', body: { url: 'https://official.example.org/feed', state: 'attiva' }, status: 400 });
  const { id } = await api('/sources', { method: 'POST', body: {
    url: 'https://official.example.org/feed', kind: 'json', state: 'attiva', terms: 'Fixture autorizzata',
  } });
  const sync = () => api(`/sources/${id}/sync`, { method: 'POST' });
  let release;
  pending = new Promise((resolve) => { release = resolve; });
  const first = sync();
  try {
    for (let i = 0; i < 50; i++) {
      if ((await api('/runs'))[0]?.state === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await api(`/sources/${id}/sync`, { method: 'POST', status: 409 });
  } finally { release(); pending = null; }
  assert.equal((await first).count, 1);
  assert.equal((await sync()).count, 0);
  cache = true;
  assert.equal((await sync()).count, 0);
  cache = false;
  const [candidate] = await api('/candidates');
  assert.equal(candidate.evidence.lat.method, 'nominatim');
  const base = '/candidates/' + candidate.id;
  await api(base + '/publish', { method: 'POST', status: 409 });
  await api(base + '/review', { method: 'POST', body: { action: 'approve', version: candidate.observed_at } });
  process.env.EVENT_DISCOVERY_SHADOW = 'true';
  await api(base + '/publish', { method: 'POST', body: { version: candidate.observed_at }, status: 409 });
  delete process.env.EVENT_DISCOVERY_SHADOW;
  const published = await Promise.all(Array.from({ length: 2 }, () =>
    api(base + '/publish', { method: 'POST', body: { version: candidate.observed_at } })));
  assert.equal(published[0].eventId, published[1].eventId);
  const eventId = published[0].eventId;
  assert.equal((await pool.query('SELECT * FROM eventi')).rowCount, 1);
  const suggestions = await api(`/events/${eventId}/territory`);
  assert.deepEqual(suggestions.suggestions[0].stops.map(String), ['2']);
  await api(`/events/${eventId}/territory`, { method: 'PUT', body: { nodeId: '1', stopId: '2' } });
  assert.equal((await api(`/events/${eventId}/territory`)).confirmed.node_id, '1');

  const second = await api('/sources', { method: 'POST', body: {
    url: 'https://mirror.example.org/feed', kind: 'json', state: 'attiva', terms: 'Fixture autorizzata',
  } });
  await api(`/sources/${second.id}/sync`, { method: 'POST' });
  const [duplicate] = await api('/candidates?state=pending');
  assert.deepEqual(duplicate.possible_duplicates, [candidate.id]);
  await api(`/candidates/${duplicate.id}/review`, { method: 'POST', body: { action: 'approve', version: duplicate.observed_at } });
  assert.equal((await api(`/candidates/${duplicate.id}/publish`, { method: 'POST', body: { version: duplicate.observed_at } })).eventId, eventId);
  await pool.query('INSERT INTO corse (evento_id) VALUES ($1)', [eventId]);
  await pool.query('INSERT INTO richieste_pop_bus (evento_id) VALUES ($1)', [eventId]);

  feed = [{ ...item, start: '2026-12-03T20:00:00Z', status: 'postponed' }];
  assert.equal((await sync()).count, 1);
  const [changed] = await api('/candidates?state=pending');
  assert.equal(changed.id, candidate.id);
  assert.equal(changed.data.status, 'changed');
  assert.equal(changed.last_change.mobilityAlert, true);
  await api(base + '/review', { method: 'POST', body: { action: 'approve', version: candidate.observed_at }, status: 409 });
  feed = [{ id: item.id, status: 'cancelled' }];
  assert.equal((await sync()).count, 1);
  feed = [];
  assert.equal((await sync()).count, 0);
  assert.equal((await api('/candidates?state=pending'))[0].data.status, 'cancelled');
  assert.equal((await api(base + '/history')).filter((row) => row.action === 'source-change').length, 2);
  networkError = true;
  await api(`/sources/${id}/sync`, { method: 'POST', status: 502 });
  assert.equal((await api('/runs'))[0].state, 'error');
  networkError = false;
  assert.equal((await sync()).count, 0);
  const result = await pool.query(`SELECT data_inizio, (SELECT count(*) FROM corse) AS corse,
    (SELECT count(*) FROM richieste_pop_bus) AS popbus FROM eventi WHERE id=$1`, [eventId]);
  assert.equal(result.rows[0].data_inizio.toISOString(), item.start.replace('Z', '.000Z'));
  assert.equal(result.rows[0].corse, '1');
  assert.equal(result.rows[0].popbus, '1');

  process.env.EVENT_DISCOVERY_AUTO_PUBLISH = 'true';
  process.env.EVENT_DISCOVERY_AUTO_PUBLISH_USER = '7';
  feed = [{ ...item, id: 'auto-2', title: 'Festival', start: '2026-11-25T20:00:00Z', url: 'https://official.example.org/festival' }];
  await sync();
  const [queued] = await api('/candidates?state=pending');
  await api(`/candidates/${queued.id}/review`, { method: 'POST',
    body: { action: 'approve', autoPublish: true, version: queued.observed_at } });
  await api('/settings', { method: 'PUT', body: { autoPublishConfidence: 60 } });
  await Promise.all([service.publishApproved(() => false), service.publishApproved(() => false)]);
  assert.equal((await pool.query('SELECT * FROM eventi')).rowCount, 2);
  const autoHistory = await api(`/candidates/${queued.id}/history`);
  assert.equal(autoHistory.filter((row) => row.action === 'publish' && row.details.automatic).length, 1);
});
