import express from 'express';
import { pool } from '../../db/db.js';
import { audit, automaticPublisher, canWrite, createDiscovery, enabled, fail, filters, mobility, number, transaction, webSearchStatus } from '../../services/event-discovery/service.js';
import { publicUrl } from '../../services/event-discovery/network.js';

const table = 'public.event_discovery_';
const actions = ['read', 'sources', 'acquire', 'review', 'publish', 'configure'];
const kinds = ['jsonld', 'html', 'json', 'ics', 'rss', 'social'];
const states = ['candidata', 'in_verifica', 'attiva', 'sospesa', 'non_supportata'];
const id = (value) => number(Number(value), 1, 2147483647);

function capabilities(user) {
  if (!['Admin', 'admin'].includes(user?.role) || !/^\d+$/.test(String(user.id))) return [];
  return actions.filter((action) => action === 'read' || canWrite(action, user.id));
}

function sourceInput(input, current = {}) {
  let url;
  try { url = publicUrl(input.url ?? current.url); } catch { fail('URL della fonte non valido'); }
  const kind = input.kind ?? current.kind ?? 'jsonld';
  const state = input.state ?? current.state ?? 'candidata';
  const name = input.name ?? current.name ?? url.hostname;
  const terms = input.terms ?? current.terms ?? '';
  const timezone = input.timezone ?? current.timezone ?? 'Europe/Rome';
  if (!kinds.includes(kind) || !states.includes(state) || typeof name !== 'string' ||
      !name.trim() || name.length > 250 || typeof terms !== 'string' || terms.length > 2000 ||
      typeof timezone !== 'string' || timezone.length > 100 || (kind === 'social' && !['candidata', 'non_supportata', 'sospesa'].includes(state)) ||
      (state === 'attiva' && !terms.trim())) fail('Configurazione della fonte non valida');
  if ([...url.searchParams.keys()].some((key) => /key|token|pass|secret|auth|credential|signature/i.test(key))) fail('Usa un URL privo di credenziali');
  try { new Intl.DateTimeFormat('it', { timeZone: timezone }); } catch { fail('Fuso orario non valido'); }
  if (kind === 'social' && !enabled('SOCIAL')) fail('Registrazione di fonti social disattivata', 503);
  if (current.state === 'attiva' && (current.url !== url.href || current.kind !== kind)) fail('Sospendi la fonte prima di cambiare URL o connettore', 409);
  return [name.trim(), url.href, url.hostname, kind, state, terms.trim(), timezone,
    number(input.interval_minutes ?? current.interval_minutes ?? 1440, 15, 43200),
    number(input.reliability ?? current.reliability ?? 50, 0, 100)];
}

export function createEventDiscoveryRouter(database = pool, service = createDiscovery(database)) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!enabled()) return res.status(404).json({ error: 'Event Discovery disattivato' });
    if (req.method !== 'GET' && (!req.is('application/json') || req.get('X-Event-Discovery') !== '1')) {
      return res.status(415).json({ error: 'Richiesta amministrativa non valida' });
    }
    if (req.method !== 'GET' && Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16384) {
      return res.status(413).json({ error: 'Richiesta troppo grande' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  const route = (method, path, capability, action) => router[method](path, async (req, res) => {
    if (!capabilities(req.user).includes(capability)) return res.status(403).json({ error: 'Permesso negato' });
    try {
      res.json(await action(req, Number(req.user.id)));
    } catch (error) {
      if (error.expected) return res.status(error.status).json({ error: error.message });
      if (error.code === '23505') return res.status(409).json({ error: 'La fonte esiste già' });
      console.error(JSON.stringify({ component: 'event-discovery', route: path, code: error.code || 'unknown' }));
      res.status(500).json({ error: 'Operazione non riuscita' });
    }
  });

  const rows = async (sql, params) => (await database.query(sql, params)).rows;
  async function write(actor, operation, action) {
    const client = await database.connect();
    try {
      return await transaction(client, async () => {
        const row = await operation(client);
        await audit(client, actor, action, row.id ?? null, row);
        return row;
      });
    } finally { client.release(); }
  }

  route('get', '/', 'read', async (req) => {
    const [metrics] = await rows(`SELECT
      (SELECT count(*)::int FROM ${table}sources WHERE state='attiva') AS monitored,
      (SELECT count(*)::int FROM ${table}candidates) AS discovered,
      (SELECT count(*)::int FROM ${table}candidates WHERE state='pending') AS pending,
      (SELECT count(*)::int FROM ${table}candidates WHERE state='approved') AS approved,
      (SELECT count(DISTINCT event_id)::int FROM ${table}candidates) AS published,
      (SELECT count(*)::int FROM (SELECT fingerprint FROM ${table}candidates GROUP BY fingerprint HAVING count(*)>1) groups) AS duplicates,
      (SELECT count(*)::int FROM ${table}runs WHERE state='error') AS errors`);
    const searchStatus = webSearchStatus();
    return { metrics, permissions: capabilities(req.user), flags: {
      search: searchStatus === 'ready', searchStatus, monitor: enabled('MONITOR'), social: enabled('SOCIAL'), shadow: enabled('SHADOW'),
      autoPublish: Boolean(automaticPublisher()),
    } };
  });
  route('get', '/settings', 'read', () => service.settings());
  route('put', '/settings', 'configure', (req, actor) => write(actor, async (client) => {
    const { rows: [{ config }] } = await client.query(`SELECT config FROM ${table}settings FOR UPDATE`);
    const updated = filters(req.body, config);
    await client.query(`UPDATE ${table}settings SET config=$1`, [updated]);
    return updated;
  }, 'settings'));

  route('get', '/sources', 'read', (req) => rows(`SELECT id,name,url,domain,kind,state,terms,timezone,interval_minutes,reliability,last_sync,last_result,last_count
    FROM ${table}sources WHERE ($1::text IS NULL OR state=$1) ORDER BY id DESC LIMIT 100 OFFSET $2`,
  [states.includes(req.query.state) ? req.query.state : null, number(Number(req.query.offset ?? 0), 0, 1000000)]));
  route('post', '/sources', 'sources', (req, actor) => write(actor, async (client) =>
    (await client.query(`INSERT INTO ${table}sources (name,url,domain,kind,state,terms,timezone,interval_minutes,reliability)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,url,kind,state,terms,timezone,interval_minutes,reliability`,
    sourceInput(req.body))).rows[0], 'source-create'));
  route('put', '/sources/:id', 'sources', (req, actor) => write(actor, async (client) => {
    const sourceId = id(req.params.id);
    const { rows: [current] } = await client.query(`SELECT * FROM ${table}sources WHERE id=$1 FOR UPDATE`, [sourceId]);
    if (!current) fail('Fonte non trovata', 404);
    const values = sourceInput(req.body, current);
    if (current.url !== values[1] && (await client.query(`SELECT 1 FROM ${table}candidates WHERE source_id=$1 LIMIT 1`, [sourceId])).rowCount) {
      fail('Registra una nuova fonte per un URL diverso', 409);
    }
    return (await client.query(`UPDATE ${table}sources SET name=$1,url=$2,domain=$3,kind=$4,state=$5,terms=$6,timezone=$7,
      interval_minutes=$8,reliability=$9,etag=NULL,last_sync=NULL WHERE id=$10
      RETURNING id,name,url,kind,state,terms,timezone,interval_minutes,reliability`, [...values, sourceId])).rows[0];
  }, 'source-edit'));

  route('post', '/discover', 'acquire', (req, actor) => service.discover(req.body, actor));
  route('post', '/sources/:id/sync', 'acquire', async (req, actor) => {
    const sourceId = id(req.params.id);
    if (!(await rows(`SELECT id FROM ${table}sources WHERE id=$1`, [sourceId])).length) fail('Fonte non trovata', 404);
    return service.sync(sourceId, actor);
  });
  route('get', '/runs', 'read', () => rows(`SELECT * FROM ${table}runs ORDER BY id DESC LIMIT 100`));
  route('get', '/candidates', 'read', async (req) => {
    const config = await service.settings();
    const candidates = await rows(`SELECT c.id,c.data,c.reviewed_data,c.evidence,c.confidence,c.state,c.event_id,c.observed_at,c.auto_publish,
    s.name AS source, s.url AS source_url,
    ARRAY(SELECT d.id FROM ${table}candidates d WHERE d.fingerprint=c.fingerprint AND d.id<>c.id LIMIT 10) AS possible_duplicates,
    (SELECT a.details FROM ${table}audit a WHERE a.entity_id=c.id AND a.action='source-change' ORDER BY a.id DESC LIMIT 1) AS last_change
    FROM ${table}candidates c JOIN ${table}sources s ON s.id=c.source_id
    WHERE ($1::text IS NULL OR c.state=$1) ORDER BY c.observed_at DESC,c.id DESC LIMIT 50 OFFSET $2`,
    [['pending', 'approved', 'published', 'rejected'].includes(req.query.state) ? req.query.state : null, number(Number(req.query.offset ?? 0), 0, 1000000)]);
    return candidates.map((candidate) => ({ ...candidate, mobility: mobility(candidate.reviewed_data || candidate.data, config) }));
  });
  route('get', '/candidates/:id/history', 'read', (req) => rows(`SELECT action,details,created_at,actor_id FROM ${table}audit
    WHERE entity_id=$1 AND action IN ('approve','reject','publish','source-change','auto-publish-skipped') ORDER BY id DESC LIMIT 100`, [id(req.params.id)]));
  route('post', '/candidates/:id/review', 'review', (req, actor) => service.review(id(req.params.id), req.body, actor));
  route('post', '/candidates/:id/publish', 'publish', (req, actor) => service.publish(id(req.params.id), req.body, actor));

  route('get', '/events/:id/territory', 'read', async (req) => {
    const eventId = id(req.params.id);
    const config = await service.settings();
    const suggestions = await rows(`WITH event AS (
      SELECT ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography AS point FROM public.eventi
      WHERE id=$1 AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
      AND EXISTS (SELECT 1 FROM ${table}candidates WHERE event_id=$1)
    ) SELECT n.id,n.nome,round(ST_Distance(n.posizione::geography,e.point)) AS metres,
      ARRAY(SELECT p.id FROM public.pixel_fermate p
        WHERE p.nodo_territoriale_id=n.id AND p.attiva AND p.verificata AND p.posizione IS NOT NULL
        AND ST_DWithin(p.posizione::geography,e.point,$2)
        ORDER BY ST_Distance(p.posizione::geography,e.point),p.id LIMIT 5) AS stops
      FROM event e CROSS JOIN public.nodi_territoriali n WHERE n.attivo AND ST_DWithin(n.posizione::geography,e.point,$2)
      ORDER BY metres,n.id LIMIT 10`, [eventId, config.radiusKm * 1000]);
    const [confirmed] = await rows(`SELECT node_id,stop_id FROM ${table}territory WHERE event_id=$1`, [eventId]);
    return { suggestions, confirmed: confirmed ?? null };
  });
  route('put', '/events/:id/territory', 'publish', (req, actor) => write(actor, async (client) => {
    if (enabled('SHADOW')) fail('Conferma territoriale disattivata in modalità shadow', 409);
    const eventId = id(req.params.id);
    const { nodeId, stopId } = req.body;
    const valid = (value) => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
    if (!valid(nodeId) || (stopId != null && !valid(stopId))) fail('ID territoriale non valido');
    const result = await client.query(`INSERT INTO ${table}territory (event_id,node_id,stop_id)
      SELECT $1,n.id,$3 FROM public.nodi_territoriali n WHERE n.id=$2 AND n.attivo
        AND EXISTS (SELECT 1 FROM ${table}candidates WHERE event_id=$1 AND state='published')
        AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM public.pixel_fermate p WHERE p.id=$3
          AND p.nodo_territoriale_id=n.id AND p.attiva AND p.verificata))
      ON CONFLICT (event_id) DO UPDATE SET node_id=excluded.node_id, stop_id=excluded.stop_id RETURNING *`, [eventId, nodeId, stopId ?? null]);
    if (!result.rowCount) fail('Evento, nodo o fermata incompatibili', 409);
    return result.rows[0];
  }, 'territory'));
  return router;
}

export default createEventDiscoveryRouter();
