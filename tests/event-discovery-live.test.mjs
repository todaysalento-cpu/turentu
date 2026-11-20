import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { andiamoPugliaEvent } from '../services/event-discovery/andiamo-puglia.js';
import { normalize, fingerprint } from '../services/event-discovery/extract.js';

const source = { timezone: 'Europe/Rome', url: 'https://andiamoinpuglia.it/dati/eventi.json' };
test('feed hours survive normalization in winter and summer without guessing missing hours', () => {
  for (const [day, hour, expected] of [
    ['2026-12-01', '21:00', '2026-12-01T20:00:00.000Z'],
    ['2027-04-09', '21:00', '2027-04-09T19:00:00.000Z'],
    ['2026-12-01', undefined, '2026-12-01'],
    ['2026-12-01', '21:00 e 22:00', '2026-12-01'],
    ['2026-12-01', '25:99', '2026-12-01'],
  ]) {
    assert.equal(normalize(andiamoPugliaEvent({ start_date: day, start_time: hour }), source).start, expected);
  }
  assert.equal(normalize(andiamoPugliaEvent({ start_date: '2026-12-01', start_time: '21:00',
    end_date: '2026-12-01', end_time: '23:00' }), source).end, '2026-12-01T22:00:00.000Z');
});

test('LIVE catalog has 80 distinct future events with official sources, explicit hours and coordinate provenance', async () => {
  const { events } = JSON.parse(await readFile(new URL('../data/event-discovery-live/catalogo-20261120.json', import.meta.url)));
  assert.equal(events.length, 80);
  const keys = new Set();
  for (const e of events) {
    const n = normalize(e, { timezone: e.timezone, url: e.url });
    assert.ok(n.title && n.category && n.venue && n.city);
    assert.ok(n.start && Date.parse(n.start) > Date.parse('2026-11-20T23:59:59+01:00'));
    assert.ok(n.lat >= 39 && n.lat <= 42.5 && n.lng >= 14.5 && n.lng <= 19);
    assert.ok(['www.pugliaculture.it', 'www.politeamagreco.it'].includes(new URL(n.url).hostname));
    assert.equal(e.verification.title_date_time_venue, 'official_calendar_checked');
    assert.ok(e.verification.coordinates_source);
    assert.equal(e.publication_ready, false);
    assert.ok(!keys.has(fingerprint(n)), `duplicate: ${n.title}`);
    keys.add(fingerprint(n));
  }
  assert.equal(new Set(events.map(e => e.province)).size, 5);
});
