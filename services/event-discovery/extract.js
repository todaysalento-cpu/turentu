import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const keyText = (value) => (value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const plain = (value, limit = 250) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, ' ').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || null
  : null;

export function eventUrl(value, base) {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const param of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(param)) url.searchParams.delete(param);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

export function timestamp(value, zone) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d)(?::(\d\d)(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)?)?$/.exec(value);
  if (!match) return null;
  const [, date, time, seconds, fraction, offset] = match;
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return null;
  if (!time) return date;
  if (+time.slice(0, 2) > 23 || +time.slice(3) > 59 || +(seconds || 0) > 59) return null;
  const local = `${date}T${time}:${seconds || '00'}`;
  const millis = Date.parse(local + (fraction || '') + (offset || 'Z'));
  if (!Number.isFinite(millis)) return null;
  if (offset) return new Date(millis).toISOString();
  const format = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const isoLocal = (instant) => format.format(instant).replace(' ', 'T');
  const offsets = new Set([-86400000, 86400000].map((delta) => {
    const probe = Math.floor(millis / 1000) * 1000 + delta;
    return Date.parse(isoLocal(probe) + 'Z') - probe;
  }));
  const matches = [...offsets].map((difference) => millis - difference).filter((date) => isoLocal(date) === local);
  return matches.length === 1 ? new Date(matches[0]).toISOString() : null;
}

function coordinate(value, maximum) {
  if (!['number', 'string'].includes(typeof value) || !String(value).trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : null;
}

export function normalize(item, source) {
  const status = String(item.status || item.eventStatus || '').split(/[\/#]/).pop().toLowerCase();
  const place = Array.isArray(item.location) ? item.location[0] : item.location;
  const address = place?.address;
  return {
    title: plain(item.title ?? item.name),
    category: plain(item.category, 100)?.toLowerCase() ?? null,
    description: plain(item.description, 4000),
    start: timestamp(item.start ?? item.startDate, source.timezone),
    end: timestamp(item.end ?? item.endDate, source.timezone),
    venue: plain(item.venue ?? place?.name ?? place),
    address: plain(item.address ?? address?.streetAddress ?? address),
    city: plain(item.city ?? address?.addressLocality),
    province: plain(item.province ?? address?.addressRegion),
    lat: coordinate(item.lat ?? place?.geo?.latitude, 90),
    lng: coordinate(item.lng ?? place?.geo?.longitude, 180),
    organizer: plain(item.organizer?.name ?? item.organizer),
    url: eventUrl(item.url, source.url),
    tickets: eventUrl(item.tickets ?? item.offers?.url ?? item.offers?.[0]?.url, source.url),
    status: ['cancelled', 'canceled', 'eventcancelled'].includes(status) ? 'cancelled'
      : ['postponed', 'eventpostponed', 'rescheduled', 'eventrescheduled'].includes(status) ? 'changed'
        : 'scheduled',
  };
}

export function fingerprint(data) {
  return hash(JSON.stringify([keyText(data.title), data.start, keyText(data.city), keyText(data.venue)]));
}

function jsonEvents(input) {
  const events = [];
  const stack = [input];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if ([item['@type']].flat().some((type) => typeof type === 'string' && /Event$/.test(type))) events.push(item);
    else for (const value of Object.values(item)) if (value && typeof value === 'object') stack.push(value);
  }
  return events;
}

function structuredHtml(body) {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(body)?.[1];
  if (!head) return [];
  const values = new Map();
  for (const tag of head.matchAll(/<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const attrs = Object.fromEntries([...tag[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map((attribute) => [attribute[1].toLowerCase(), attribute[2] ?? attribute[3]]));
    if (attrs.content && (attrs.property || attrs.name)) values.set((attrs.property || attrs.name).toLowerCase(), attrs.content);
  }
  if (values.get('og:type') !== 'event' || !values.get('event:start_time')) return [];
  return [{
    title: values.get('og:title'), description: values.get('og:description'),
    start: values.get('event:start_time'), end: values.get('event:end_time'),
    venue: values.get('event:location'), url: values.get('og:url'),
  }];
}

function calendarDate(value = '') {
  return value.replace(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?$/, (_, y, m, d, h, min, s, z) =>
    `${y}-${m}-${d}${h ? `T${h}:${min}:${s}${z || ''}` : ''}`);
}

const dayMillis = 86400000;
function shiftCalendarDate(value, days) {
  if (!value) return value;
  const date = Date.parse(value.slice(0, 10)) + days * dayMillis;
  return new Date(date).toISOString().slice(0, 10) + value.slice(10);
}

function expand(item, rule, excluded, now, days) {
  if (!rule || !item.start) return [item];
  const parts = Object.fromEntries(rule.split(';').map((part) => part.split('=')));
  const step = (parts.FREQ === 'DAILY' ? 1 : parts.FREQ === 'WEEKLY' ? 7 : 0) * Number(parts.INTERVAL || 1);
  const count = parts.COUNT === undefined ? Infinity : Number(parts.COUNT);
  if (!Number.isSafeInteger(step) || step < 1 || step > 3650 || !(count > 0) ||
      Object.keys(parts).some((key) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL'].includes(key))) return [item];
  const start = Date.parse(item.start.slice(0, 10));
  if (!Number.isFinite(start)) return [item];
  const end = now.getTime() + (days + 1) * dayMillis;
  const first = Math.max(0, Math.floor((now.getTime() - start) / (step * dayMillis)) - 2);
  const until = parts.UNTIL ? calendarDate(parts.UNTIL) : null;
  const results = [];
  for (let index = first; index < count && start + index * step * dayMillis <= end && results.length < 500; index++) {
    const occurrence = shiftCalendarDate(item.start, index * step);
    if (until && occurrence.slice(0, 10) > until.slice(0, 10)) break;
    if (excluded.has(occurrence)) continue;
    results.push({ ...item, start: occurrence, end: shiftCalendarDate(item.end, index * step),
      id: item.id ? item.id + '/' + occurrence : undefined, recurring: false });
  }
  return results;
}

function calendar(body, now, days) {
  const items = [];
  const exceptions = [];
  for (const match of body.replace(/\r?\n[ \t]/g, '').matchAll(/^BEGIN:VEVENT\r?\n([\s\S]*?)^END:VEVENT\r?$/gim)) {
    const fields = new Map();
    const excluded = new Set();
    for (const line of match[1].split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const [name, ...params] = line.slice(0, colon).split(';');
      const value = line.slice(colon + 1).replace(/\\([,;nN\\])/g, (_, ch) => /n/i.test(ch) ? ' ' : ch);
      if (name.toUpperCase() === 'EXDATE') for (const occurrence of value.split(',')) excluded.add(calendarDate(occurrence));
      fields.set(name.toUpperCase(), { value, params });
    }
    const get = (name) => fields.get(name)?.value;
    const recurrence = get('RECURRENCE-ID');
    const zone = (name) => fields.get(name)?.params.find((part) => /^TZID=/i.test(part))?.slice(5).replace(/^"|"$/g, '');
    const tz = zone('DTSTART') || zone('DTEND');
    if (tz) new Intl.DateTimeFormat('it', { timeZone: tz });
    if (zone('DTEND') && zone('DTSTART') && zone('DTEND') !== zone('DTSTART')) {
      throw new Error('Fusi distinti per inizio e fine ICS');
    }
    const item = {
      id: get('UID'),
      title: get('SUMMARY'), description: get('DESCRIPTION'), venue: get('LOCATION'),
      category: get('CATEGORIES')?.split(',')[0], start: calendarDate(get('DTSTART')),
      end: calendarDate(get('DTEND')), status: get('STATUS'), url: get('URL'), tz,
      recurring: fields.has('RRULE') || fields.has('RDATE') || fields.has('EXDATE'),
    };
    if (recurrence && item.id) exceptions.push({ ...item, id: item.id + '/' + calendarDate(recurrence) });
    else items.push(...expand(item, fields.has('RDATE') ? null : get('RRULE'), excluded, now, days));
  }
  if (!/^BEGIN:VCALENDAR\r?$/im.test(body) || !/^END:VCALENDAR\r?$/im.test(body)) throw new Error('Calendario ICS non valido');
  const replaced = new Set(exceptions.map((item) => item.id));
  return [...items.filter((item) => !replaced.has(item.id)), ...exceptions];
}

async function rss(body) {
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new Error('Feed XML non valido');
  const doc = new XMLParser({ processEntities: false, parseTagValue: false }).parse(body);
  if (!doc.rss?.channel) throw new Error('Feed RSS non valido');
  return [doc.rss.channel.item || []].flat().map((item) => ({
    id: item.guid?.['#text'] ?? item.guid, title: item.title, description: item.description, url: item.link,
    category: [item.category].flat()[0], start: item['event:startDate'] ?? item['ev:startdate'],
    end: item['event:endDate'] ?? item['ev:enddate'], venue: item['event:location'] ?? item['ev:location'],
  }));
}

export async function extract(body, source, days, now = new Date()) {
  let items;
  if (source.kind === 'ics') items = calendar(body, now, days);
  else if (source.kind === 'rss') items = await rss(body);
  else if (source.kind === 'json') {
    const parsed = JSON.parse(body);
    items = Array.isArray(parsed) ? parsed : parsed.events;
    if (!Array.isArray(items)) throw new Error('Atteso un array JSON di eventi');
  } else {
    items = [];
    for (const script of body.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      let parsed;
      try { parsed = JSON.parse(script[1]); } catch { continue; }
      items.push(...jsonEvents(parsed));
    }
    if (!items.length && source.kind === 'html') items = structuredHtml(body);
  }
  const startDay = new Intl.DateTimeFormat('sv-SE', { timeZone: source.timezone, dateStyle: 'short' }).format(now);
  const end = now.getTime() + days * 86400000;
  return items.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const data = normalize(item, { ...source, timezone: item.tz || source.timezone });
    const rawId = item.id ?? item['@id'];
    const id = plain(typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId, 1024);
    const start = data.start?.length === 10 ? Date.parse(data.start + 'T23:59:59Z') : Date.parse(data.start);
    const actionable = data.status !== 'scheduled';
    if ((!data.title || !data.start) && !id && !data.url) return [];
    if (!actionable && data.start && (data.start.length === 10 ? data.start < startDay : (Date.parse(data.end) || start) < now.getTime())) return [];
    if (!actionable && start > end + (data.start?.length === 10 ? 86400000 : 0)) return [];
    const confidence = (source.reliability + (data.start && data.venue ? 80 : 30)) / 2;
    const evidence = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null).map(([field, value]) =>
      [field, { url: source.url, value, method: source.kind, confidence: Math.floor(confidence) }]));
    if (item.recurring) evidence.recurrence = { method: 'ics', value: 'Serie da verificare' };
    const canonicalKey = ['jsonld', 'html'].includes(source.kind) && items.length === 1 && data.url === eventUrl(source.url)
      ? data.url : data.url + ':' + (data.start || '');
    return [{
      data, evidence, confidence: Math.floor(confidence),
      key: hash(id ? 'id:' + id : data.url ? 'url:' + canonicalKey : fingerprint(data)),
      fingerprint: fingerprint(data),
    }];
  });
}
