import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, timestamp } from '../services/event-discovery/extract.js';
import { publicUrl, readRemote, readSource } from '../services/event-discovery/network.js';

const now = new Date('2026-11-10T11:00:00Z');
const source = { url: 'https://eventi.example.org/calendar', timezone: 'Europe/Rome', reliability: 80 };
const parse = (body, kind) => extract(body, { ...source, kind }, 90, now);

test('date locali, fusi, ora inesistente e ambigua', () => {
  assert.equal(timestamp('2026-11-15T21:00', 'Europe/Rome'), '2026-11-15T20:00:00.000Z');
  assert.equal(timestamp('2026-11-15T21:00+02:00', 'Europe/Rome'), '2026-11-15T19:00:00.000Z');
  assert.equal(timestamp('2027-03-28T02:30', 'Europe/Rome'), null);
  assert.equal(timestamp('2026-10-25T02:30', 'Europe/Rome'), null);
  assert.equal(timestamp('2026-02-30', 'Europe/Rome'), null);
  assert.equal(timestamp('2026-11-15', 'Europe/Rome'), '2026-11-15');
});

test('JSON API e HTML con JSON-LD, coordinate ed evidenze', async () => {
  const [api] = await parse(JSON.stringify({ events: [{ id: 52, title: 'Concerto', start: '2026-11-22T20:00', venue: 'Teatro', lat: 0, lng: 18 }] }), 'json');
  assert.equal(api.data.lat, 0);
  assert.equal(api.evidence.start.method, 'json');
  const [html] = await parse(`<h1>Pagina evento</h1><script type="application/ld+json">
    {"@graph":[{"@type":"MusicEvent","name":"Concerto","startDate":"2026-11-22","url":"/concerto?utm_source=test",
      "location":{"name":"Teatro","address":{"addressLocality":"Lecce"},"geo":{"latitude":40.35,"longitude":18.17}}}]}
    </script>`, 'jsonld');
  assert.equal(html.data.city, 'Lecce');
  assert.equal(html.data.url, 'https://eventi.example.org/concerto');
  assert.equal(html.data.start, '2026-11-22');
  assert.equal(html.data.lat, 40.35);
});

test('Andiamo in Puglia scorre lo storico e importa date e attribuzione senza inventare orari', async () => {
  const feed = { ...source, kind: 'json', url: 'https://andiamoinpuglia.it/dati/eventi.json' };
  const old = { title: 'Evento concluso', start_date: '2025-11-10', status: 'programmato' };
  const event = { slug: 'mostra-lecce', title: 'Mostra a Lecce', start_date: '2026-11-09', end_date: '2026-11-12',
    venue_name: 'Museo', comune_name: 'Lecce', provincia: 'lecce', street: 'Via Roma', lat: 40.35, lng: 18.17,
    url: '/eventi/mostra-lecce/', source_urls: ['https://comune.example.org/mostra'], status: 'programmato' };
  const json = JSON.stringify({ license: 'CC BY 4.0', events: [...Array(501).fill(old), event] });
  const [candidate, extra] = await extract(json, feed, 90, now);
  assert.equal(extra, undefined);
  assert.equal(candidate.data.start, '2026-11-09');
  assert.equal(candidate.data.end, '2026-11-12');
  assert.equal(candidate.data.venue, 'Museo');
  assert.equal(candidate.data.city, 'Lecce');
  assert.equal(candidate.data.lat, 40.35);
  assert.deepEqual(candidate.evidence.attribution, {
    publisher: 'andiamoinpuglia.it', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    recordUrl: 'https://andiamoinpuglia.it/eventi/mostra-lecce/', primaryUrl: 'https://comune.example.org/mostra',
  });
  await assert.rejects(extract(JSON.stringify({ events: [event] }), feed, 90, now), /Licenza/);
  const [generic] = await parse(JSON.stringify({ events: [event] }), 'json');
  assert.equal(generic.data.start, null);
  assert.equal(generic.evidence.attribution, undefined);
});

test('RSS: pubDate è la data di pubblicazione, non l’inizio', async () => {
  const [event] = await parse(`<?xml version="1.0"?><rss version="2.0" xmlns:event="https://example.org/">
    <channel><title>Eventi</title><item><guid>uno</guid><title>Evento</title>
    <pubDate>Tue, 10 Nov 2026 12:00:00 GMT</pubDate>
    <event:startDate>2026-11-15T21:00</event:startDate><event:location>Teatro</event:location></item>
    <item><guid>due</guid><title>Evento 2</title><pubDate>Tue, 10 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`, 'rss');
  assert.equal(event.data.start, '2026-11-15T20:00:00.000Z');
  const [undated] = await parse('<rss><channel><item><guid>due</guid><title>Evento</title><pubDate>2026-11-30</pubDate></item></channel></rss>', 'rss');
  assert.equal(undated.data.start, null);
  await assert.rejects(parse('<!DOCTYPE rss><rss/>', 'rss'), /XML non valido/);
});

test('HTML con metadati evento e identificazione della pagina dopo un cambio di data', async () => {
  const body = `<html><head><meta property="og:type" content="event">
    <meta property="og:title" content="Concerto"><meta property="event:start_time" content="2026-11-21T21:00">
    <meta property="event:location" content="Teatro"><meta property="og:url" content="${source.url}"></head>
    <body><p>Data di pubblicazione 2026-11-01</p></body></html>`;
  const [event] = await parse(body, 'html');
  assert.equal(event.data.start, '2026-11-21T20:00:00.000Z');
  const [changed] = await parse(body.replace('2026-11-21', '2026-11-22'), 'html');
  assert.equal(event.key, changed.key);
  assert.notEqual(event.fingerprint, changed.fingerprint);
  assert.deepEqual(await parse(body.replace('content="event"', 'content="article"'), 'html'), []);
});

test('ICS settimanale con esclusione, modifica singola e fuso IANA', async () => {
  const body = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:series', 'SUMMARY:Festival',
    'DTSTART;TZID=Europe/Rome:20261111T210000', 'DTEND;TZID=Europe/Rome:20261111T230000',
    'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;TZID=Europe/Rome:20261118T210000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID;TZID=Europe/Rome:20261125T210000',
    'SUMMARY:Festival spostato', 'DTSTART;TZID=Europe/Rome:20261126T220000', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const result = await parse(body, 'ics');
  assert.deepEqual(result.map(({ data }) => data.start), ['2026-11-11T20:00:00.000Z', '2026-11-26T21:00:00.000Z']);
  assert.equal(result[0].data.end, '2026-11-11T22:00:00.000Z');
  const original = await parse(body.split('END:VEVENT')[0].replace('COUNT=3', 'COUNT=1') +
    'END:VEVENT\r\nEND:VCALENDAR', 'ics');
  assert.equal(result[0].key, original[0].key);
});

test('policy URL e robots; ETag inoltrato al connettore', async () => {
  assert.throws(() => publicUrl('file:///temp/eventi'), /consentito/);
  assert.throws(() => publicUrl('https://localhost/eventi'), /consentito/);
  assert.throws(() => publicUrl('https://example.org:444/eventi'), /consentito/);
  await assert.rejects(readSource(source, async () => ({ body: 'User-agent: *\nDisallow: /calendar' })), /robots/);
  let called = 0;
  await readSource({ ...source, etag: '"abc"' }, async (url, headers) => {
    called++;
    if (url.endsWith('robots.txt')) throw Object.assign(new Error('missing'), { status: 404 });
    assert.equal(headers['If-None-Match'], '"abc"');
    return { status: 304 };
  });
  assert.equal(called, 2);
});

test('retry con backoff per errori transitori e rispetto del limite HTTP 429', async () => {
  const waits = [];
  let count = 0;
  const result = await readRemote(source.url, {}, async () => {
    count++;
    if (count === 1) throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' });
    return { status: count === 2 ? 503 : 200 };
  }, async (ms) => { waits.push(ms); });
  assert.equal(result.status, 200);
  assert.deepEqual(waits, [500, 1000]);
  count = 0;
  await assert.rejects(readRemote(source.url, {}, async () => {
    count++;
    return { status: 429 };
  }), { status: 429 });
  assert.equal(count, 1);
});
