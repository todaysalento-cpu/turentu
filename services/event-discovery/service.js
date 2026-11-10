import { setTimeout as delay } from 'node:timers/promises';
import { extract, fingerprint, keyText, normalize } from './extract.js';
import { publicUrl, readRemote, readSource } from './network.js';
import { geocode } from './geocode.js';

const tables = 'public.event_discovery_';
export const enabled = (name = '') => process.env['EVENT_DISCOVERY_ENABLED'] === 'true' &&
  (!name || process.env['EVENT_DISCOVERY_' + name] === 'true');

export function canWrite(action, actor) {
  return (process.env['EVENT_DISCOVERY_' + action.toUpperCase() + '_USERS'] || '')
    .split(',').map((item) => item.trim()).includes(String(actor));
}

export function automaticPublisher() {
  if (!enabled('AUTO_PUBLISH') || enabled('SHADOW')) return null;
  const actor = Number(process.env.EVENT_DISCOVERY_AUTO_PUBLISH_USER);
  return Number.isInteger(actor) && actor > 0 && actor <= 2147483647 && canWrite('publish', actor) ? actor : null;
}

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status, expected: true });
}

export function number(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('Valore numerico fuori intervallo');
  return value;
}

function words(value, limit, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > limit ||
      value.some((word) => typeof word !== 'string' || !word.trim() || word.length > 70 || /[\r\n]/.test(word))) {
    fail('Elenco non valido');
  }
  return [...new Set(value.map((word) => word.trim()))];
}

export function filters(input, defaults) {
  return {
    territories: words(input.territories ?? defaults.territories, 15),
    categories: words(input.categories ?? defaults.categories, 15),
    highPriority: words(input.highPriority ?? defaults.highPriority ?? [], 15, 0),
    mediumPriority: words(input.mediumPriority ?? defaults.mediumPriority ?? [], 15, 0),
    days: number(input.days ?? defaults.days, 1, 365),
    intervalMinutes: number(input.intervalMinutes ?? defaults.intervalMinutes, 60, 43200),
    radiusKm: number(input.radiusKm ?? defaults.radiusKm, 1, 100),
    autoPublishConfidence: number(input.autoPublishConfidence ?? defaults.autoPublishConfidence ?? 90, 0, 100),
  };
}

export function mobility(data, config) {
  const category = keyText(data.category);
  if (!category) return 'da classificare';
  if ((config.highPriority || []).some((value) => keyText(value) === category)) return 'alta';
  if ((config.mediumPriority || []).some((value) => keyText(value) === category)) return 'media';
  return 'ordinaria';
}

export async function transaction(client, action) {
  await client.query('BEGIN');
  try {
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export function audit(client, actor, action, id, details = {}) {
  return client.query(`INSERT INTO ${tables}audit (actor_id, action, entity_id, details) VALUES ($1,$2,$3,$4)`,
    [actor, action, id, details]);
}

async function connection(pool, action) {
  const client = await pool.connect();
  try { return await action(client); } finally { client.release(); }
}

export function createDiscovery(pool, { read = readRemote, now = () => new Date() } = {}) {
  const settings = async (client = pool) => (await client.query(`SELECT config FROM ${tables}settings`)).rows[0].config;

  async function run(kind, sourceId, actor, acquire, persist) {
    const client = await pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(645019, 1) AS locked')).rows[0].locked;
      if (!locked) fail('Un’acquisizione è già in corso', 409);
      await client.query(`UPDATE ${tables}runs SET state='error', finished_at=now(), error='Esecuzione interrotta' WHERE state='running'`);
      if (sourceId) {
        const { rows: [source] } = await client.query(`SELECT state,
          last_sync IS NULL OR last_sync + interval_minutes * interval '1 minute' <= now() AS due FROM ${tables}sources WHERE id=$1`, [sourceId]);
        if (!source) fail('Fonte non trovata', 404);
        if (source.state !== 'attiva' || (actor === null && !source.due)) fail('Fonte non attiva o già sincronizzata', 409);
      }
      if (kind === 'search') {
        const recent = await client.query(`SELECT count(*)::int AS total FROM ${tables}runs
          WHERE kind='search' AND started_at > now() - interval '24 hours'`);
        if (recent.rows[0].total >= 5) fail('Limite giornaliero di ricerca raggiunto', 429);
        if (actor === null) {
          const config = await settings(client);
          const latest = await client.query(`SELECT 1 FROM ${tables}runs WHERE kind='search'
            AND started_at > now() - $1 * interval '1 minute' LIMIT 1`, [config.intervalMinutes]);
          if (latest.rowCount) fail('Ricerca già eseguita', 409);
        }
      }
      const id = await transaction(client, async () => {
        const result = await client.query(`INSERT INTO ${tables}runs (kind,source_id) VALUES ($1,$2) RETURNING id`, [kind, sourceId]);
        await audit(client, actor, kind, result.rows[0].id, { sourceId });
        return result.rows[0].id;
      });
      const started = Date.now();
      try {
        const result = await acquire(client);
        const output = await transaction(client, async () => {
          const saved = await persist(client, result);
          await client.query(`UPDATE ${tables}runs SET state='success', finished_at=now(), count=$2 WHERE id=$1`, [id, saved.count]);
          return saved;
        });
        console.info(JSON.stringify({ component: 'event-discovery', id, kind, count: output.count, durationMs: Date.now() - started }));
        return { id, ...output };
      } catch (error) {
        const message = error.expected ? error.message : error.status ? `HTTP ${error.status}` : 'Acquisizione non riuscita';
        await transaction(client, async () => {
          await client.query(`UPDATE ${tables}runs SET state='error', finished_at=now(), error=$2 WHERE id=$1`, [id, message]);
          if (sourceId) await client.query(`UPDATE ${tables}sources SET last_sync=now(), last_result=$2 WHERE id=$1`, [sourceId, message]);
        });
        console.warn(JSON.stringify({ component: 'event-discovery', id, kind, error: message, durationMs: Date.now() - started }));
        if (error.expected) throw error;
        fail(message, 502);
      }
    } finally {
      // Destroy the dedicated connection so a failed cleanup cannot leak a session lock.
      client.release(locked);
    }
  }

  async function discover(input, actor) {
    if (!enabled('SEARCH') || !process.env.EVENT_DISCOVERY_BRAVE_KEY) fail('Provider di ricerca non configurato', 503);
    if (actor === null && !enabled('BRAVE_STORAGE_AUTHORIZED')) fail('Ricerca pianificata priva di autorizzazione alla conservazione', 503);
    return run('search', null, actor, async (client) => {
      const config = filters(input, await settings(client));
      const current = now();
      const until = new Date(current.getTime() + config.days * 86400000);
      const month = (date) => new Intl.DateTimeFormat('it', { month: 'long', year: 'numeric', timeZone: 'Europe/Rome' }).format(date);
      const jobs = config.territories.flatMap((territory) => config.categories.map((category) =>
        `eventi ${category} ${territory} ${month(current)} ${month(until)}`));
      const requested = Math.min(jobs.length, 12);
      const offset = input.territories || input.categories ? 0 : Math.floor(current.getTime() / 86400000) * requested % jobs.length;
      const urls = new Set();
      for (let i = 0; i < requested; i++) {
        const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
        endpoint.search = new URLSearchParams({ q: jobs[(offset + i) % jobs.length], country: 'IT', search_lang: 'it', count: '10' });
        const { body } = await read(endpoint.href, { Accept: 'application/json', 'X-Subscription-Token': process.env.EVENT_DISCOVERY_BRAVE_KEY });
        for (const hit of JSON.parse(body).web?.results || []) {
          try {
            const url = publicUrl(hit.url);
            if ([...url.searchParams.keys()].some((key) => /key|token|pass|secret|auth|credential|signature/i.test(key))) continue;
            for (const param of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(param)) url.searchParams.delete(param);
            url.searchParams.sort();
            urls.add(url.href);
          } catch { /* Ignore unsupported result URLs. */ }
        }
        if (i + 1 < requested) await delay(1050);
      }
      return [...urls];
    }, async (client, urls) => {
      if (!enabled('BRAVE_STORAGE_AUTHORIZED')) return { count: urls.length, urls };
      let count = 0;
      for (const value of urls) {
        const domain = publicUrl(value).hostname;
        const result = await client.query(`INSERT INTO ${tables}sources (name,url,domain,kind) VALUES ($1,$2,$1,'jsonld') ON CONFLICT (url) DO NOTHING`, [domain, value]);
        count += result.rowCount;
      }
      return { count };
    });
  }

  async function sync(sourceId, actor) {
    if (!enabled('MONITOR')) fail('Monitoraggio disattivato', 503);
    return run('sync', sourceId, actor, async (client) => {
      const { rows: [source] } = await client.query(`SELECT * FROM ${tables}sources WHERE id=$1`, [sourceId]);
      if (source?.state !== 'attiva') fail('Fonte non attiva', 409);
      if (!source.last_full_sync || Date.now() - source.last_full_sync.getTime() > 86400000) source.etag = null;
      const response = await readSource(source, read);
      const config = await settings(client);
      const candidates = response.status === 304 ? [] : await extract(response.body, source, config.days, now());
      const missing = candidates.filter(({ data }) => (data.lat == null || data.lng == null) &&
        data.address && data.city && data.status === 'scheduled');
      if (missing.length) {
        const previous = await client.query(`SELECT external_key,data,evidence FROM ${tables}candidates
          WHERE source_id=$1 AND external_key=ANY($2::text[])`, [sourceId, missing.map((item) => item.key)]);
        const cached = new Map(previous.rows.map((row) => [row.external_key, row]));
        let attempts = 0;
        for (const item of missing) {
          const saved = cached.get(item.key);
          const evidence = saved?.evidence.geocode;
          if (evidence && saved.data.address === item.data.address && saved.data.city === item.data.city) {
            item.data.lat = saved.data.lat;
            item.data.lng = saved.data.lng;
            item.evidence.geocode = evidence;
          } else if (enabled('GEO') && process.env.EVENT_DISCOVERY_GEOCODER_URL && attempts < 4) {
            if (attempts++) await delay(1050);
            const match = await geocode(item.data, process.env.EVENT_DISCOVERY_GEOCODER_URL, read).catch(() => {
              console.warn(JSON.stringify({ component: 'event-discovery', sourceId, action: 'geocode', result: 'unavailable' }));
              return null;
            });
            if (match) {
              item.data.lat = match.lat;
              item.data.lng = match.lng;
              item.evidence.geocode = match;
            }
          }
          if (item.evidence.geocode) {
            for (const field of ['lat', 'lng']) {
              item.evidence[field] = { url: item.evidence.geocode.source, value: item.data[field], method: 'nominatim', confidence: 60 };
            }
          }
        }
      }
      return { source, response, candidates };
    }, async (client, { source, response, candidates }) => {
      const { rows: [current] } = await client.query(`SELECT * FROM ${tables}sources WHERE id=$1 FOR UPDATE`, [sourceId]);
      if (current.state !== 'attiva' || current.kind !== source.kind || current.timezone !== source.timezone ||
          current.terms !== source.terms || current.reliability !== source.reliability) fail('Fonte modificata durante l’acquisizione', 409);
      let changes = 0;
      for (const item of candidates) {
        const { rows: [previous] } = await client.query(`SELECT * FROM ${tables}candidates WHERE source_id=$1 AND external_key=$2 FOR UPDATE`, [sourceId, item.key]);
        if (previous && fingerprint(previous.data) === item.fingerprint &&
            Object.entries(item.data).every(([key, value]) => previous.data[key] === value)) continue;
        if (previous) {
          const dependency = previous.event_id ? await client.query(`
            SELECT EXISTS (SELECT 1 FROM public.corse WHERE evento_id=$1)
                OR EXISTS (SELECT 1 FROM public.richieste_pop_bus WHERE evento_id=$1) AS linked`, [previous.event_id]) : null;
          await audit(client, null, 'source-change', previous.id, {
            previous: previous.data, current: item.data, eventId: previous.event_id, mobilityAlert: dependency?.rows[0].linked ?? false,
          });
        }
        await client.query(`INSERT INTO ${tables}candidates (source_id,external_key,data,evidence,fingerprint,confidence)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_id,external_key) DO UPDATE SET
          data=excluded.data,evidence=excluded.evidence,fingerprint=excluded.fingerprint,confidence=excluded.confidence,
          state='pending',reviewed_data=NULL,auto_publish=false,observed_at=now()`,
        [sourceId, item.key, item.data, item.evidence, item.fingerprint, item.confidence]);
        changes++;
      }
      await client.query(`UPDATE ${tables}sources SET last_sync=now(), last_result=$2,
        last_full_sync=CASE WHEN $2='invariata' THEN last_full_sync ELSE now() END,
        last_count=CASE WHEN $2='invariata' THEN last_count ELSE $3 END,
        etag=CASE WHEN $2='invariata' THEN etag ELSE $4 END WHERE id=$1`,
      [sourceId, response.status === 304 ? 'invariata' : 'ok', candidates.length, response.headers.etag?.slice(0, 1024) ?? null]);
      return { count: changes };
    });
  }

  async function review(id, input, actor) {
    if (!['approve', 'reject'].includes(input.action)) fail('Azione di revisione non valida');
    return connection(pool, (client) => transaction(client, async () => {
      const { rows: [candidate] } = await client.query(`SELECT * FROM ${tables}candidates WHERE id=$1 FOR UPDATE`, [id]);
      if (!candidate) fail('Candidato non trovato', 404);
      if (candidate.state !== 'pending' || input.version !== candidate.observed_at.toISOString()) fail('Il candidato è cambiato', 409);
      const data = input.action === 'approve' ? normalize({ ...candidate.data, ...input.data }, { timezone: 'Europe/Rome' }) : null;
      if (data) data.status = candidate.data.status;
      const state = data ? 'approved' : 'rejected';
      const automatic = Boolean(data && !candidate.event_id && data.status === 'scheduled' && canWrite('publish', actor) &&
        input.autoPublish === true && automaticPublisher());
      if (input.autoPublish === true && !automatic) fail('Pubblicazione programmata non disponibile', 409);
      await client.query(`UPDATE ${tables}candidates SET state=$2,reviewed_data=$3,auto_publish=$4 WHERE id=$1`, [id, state, data, automatic]);
      await audit(client, actor, input.action, id, { data, automatic });
      return { id, state };
    }));
  }

  async function publish(id, input, actor, automatic = false) {
    if (enabled('SHADOW')) fail('Pubblicazione disattivata in modalità shadow', 409);
    return connection(pool, (client) => transaction(client, async () => {
      await client.query('SELECT pg_advisory_xact_lock(645019, 2)');
      const { rows: [candidate] } = await client.query(`SELECT * FROM ${tables}candidates WHERE id=$1 FOR UPDATE`, [id]);
      if (!candidate) fail('Candidato non trovato', 404);
      if (candidate.state === 'published' && candidate.event_id) return { eventId: candidate.event_id };
      if (candidate.state !== 'approved' || input.version !== candidate.observed_at.toISOString()) fail('Serve una revisione aggiornata', 409);
      if (automatic && (!candidate.auto_publish || actor !== automaticPublisher() ||
          candidate.confidence < (await settings(client)).autoPublishConfidence)) fail('Pubblicazione programmata non autorizzata', 409);
      const event = candidate.reviewed_data;
      if (candidate.event_id || event.status !== 'scheduled') fail('Modifica o cancellazione da gestire sul record esistente', 409);
      const match = await client.query(`SELECT DISTINCT event_id FROM ${tables}candidates
        WHERE event_id IS NOT NULL AND published_data->>'url'=$1 AND published_data->>'start'=$2 LIMIT 2`, [event.url, event.start]);
      const existing = input.eventId == null ? null : number(input.eventId, 1, 2147483647);
      if (match.rowCount > 1 || (match.rowCount === 1 && existing && existing !== match.rows[0].event_id)) fail('Collegamenti esistenti in conflitto', 409);
      let eventId = existing || match.rows[0]?.event_id;
      if (eventId) {
        if (!(await client.query('SELECT id FROM public.eventi WHERE id=$1 FOR KEY SHARE', [eventId])).rowCount) fail('Evento esistente non trovato', 404);
      } else {
        if (!event.title || !event.category || !event.venue || !event.start?.includes('T') ||
            Date.parse(event.start) <= now().getTime() || (event.end && (!event.end.includes('T') || event.end < event.start))) {
          fail('Titolo, categoria, luogo e data futura con orario sono obbligatori. Verifica anche la data di fine');
        }
        const nearby = await client.query(`SELECT id,titolo,citta,luogo_nome FROM public.eventi
          WHERE data_inizio >= $1::timestamptz - interval '24 hours' AND data_inizio <= $1::timestamptz + interval '24 hours'`, [event.start]);
        const probable = nearby.rows.filter((row) => keyText(row.titolo) === keyText(event.title) &&
          (!row.citta || !event.city || keyText(row.citta) === keyText(event.city)));
        if (probable.length && input.distinct !== true) fail('Possibile duplicato. ID evento: ' + probable.map((row) => row.id).join(', '), 409);
        const inserted = await client.query(`INSERT INTO public.eventi
          (titolo,categoria,descrizione,data_inizio,data_fine,luogo_nome,indirizzo,citta,lat,lng,creato_da)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [event.title, event.category, event.description, event.start, event.end, event.venue, event.address, event.city, event.lat, event.lng, actor]);
        eventId = inserted.rows[0].id;
      }
      await client.query(`UPDATE ${tables}candidates SET state='published',event_id=$2,published_data=$3,auto_publish=false WHERE id=$1`, [id, eventId, event]);
      await audit(client, actor, 'publish', id, { eventId, automatic, distinct: input.distinct === true, linked: Boolean(existing || match.rowCount) });
      return { eventId };
    }));
  }

  async function publishApproved(stopping) {
    const actor = automaticPublisher();
    if (!actor) return;
    const { rows } = await pool.query(`SELECT id,observed_at FROM ${tables}candidates WHERE state='approved' AND auto_publish
      ORDER BY observed_at,id LIMIT 10`);
    for (const candidate of rows) {
      if (stopping()) break;
      const version = candidate.observed_at.toISOString();
      try { await publish(candidate.id, { version }, actor, true); }
      catch (error) {
        if (!error.expected) throw error;
        await connection(pool, (client) => transaction(client, async () => {
          const result = await client.query(`UPDATE ${tables}candidates SET auto_publish=false
            WHERE id=$1 AND state='approved' AND auto_publish AND date_trunc('milliseconds',observed_at)=$2::timestamptz`, [candidate.id, version]);
          if (result.rowCount) await audit(client, actor, 'auto-publish-skipped', candidate.id, { reason: error.message });
        }));
      }
    }
  }

  return { settings, discover, sync, review, publish, publishApproved };
}
