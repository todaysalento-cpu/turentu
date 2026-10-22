// tests/test-pixel-minimo.js - solo funzioni pure, zero Google e zero scritture.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { selectPixelComuneCandidates } from '../services/pixel/pixel-stop-selection-comune.service.js';

const n1 = { id: '1', lat: 39.95, lon: 18.30 };
const n8 = { id: '8', lat: 39.95, lon: 18.36 };
const c = (place_id, lat, lon, priorita = 60) => ({ place_id, lat, lon, priorita, tipo: 'trasporto' });
const results = [
  { nodo: n1, radiusMeters: 3000, candidati: [c('A', 39.95, 18.30, 100), c('B', 39.95, 18.31), c('C', 39.95, 18.32)] },
  { nodo: n8, radiusMeters: 3000, candidati: [c('D', 39.95, 18.36, 95), c('E', 39.95, 18.35), c('A', 39.95, 18.30, 100)] },
];
try {
  const r = selectPixelComuneCandidates(results, 3);
  assert.equal(r.candidati_distinti, 5, 'deduplicazione Place ID');
  assert.equal(r.selezionati.length, 3, 'rispetto del limite');
  assert.equal(new Set(r.selezionati.map(x => x.place_id)).size, 3, 'assenza duplicati');
  assert(r.copertura_nodi.every(x => x.candidati_selezionati_raggiungibili >= 1), 'copertura entrambi i nodi');
  const zero = selectPixelComuneCandidates(results, 0);
  assert.equal(zero.selezionati.length, 0, 'budget zero');
  console.log('OK: test minimo selezione comunale, deduplica, copertura e budget.');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
