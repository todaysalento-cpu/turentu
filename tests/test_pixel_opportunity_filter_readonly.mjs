// Copiare in tests/test_pixel_opportunity_filter_readonly.mjs
// Eseguire dalla root: node -r dotenv/config tests/test_pixel_opportunity_filter_readonly.mjs
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';

let client;
let begun = false;
let failed = false;
try {
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  begun = true;
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  const all = await leggiOpportunitaPixel({ client, limit: 1000 });
  assert(all.length > 0, 'nessuna opportunita candidata attiva disponibile per il test');
  const ids = all.map(o => Number(o.pixel_opportunita_id));
  assert.equal(new Set(ids).size, ids.length, 'ID opportunita duplicati');
  const target = ids.at(-1); // volutamente l'ultima: dimostra filtro prima del LIMIT
  const one = await leggiOpportunitaPixel({ client, limit: 1, opportunityIds: [target] });
  assert.deepEqual(one.map(o => Number(o.pixel_opportunita_id)), [target], 'filtro SQL non applicato prima del LIMIT');
  console.log('PASS 1: filtro SQL prima del LIMIT, opportunita', target);

  const missing = Math.max(...ids) + 1000000;
  const empty = await leggiOpportunitaPixel({ client, limit: 1, opportunityIds: [missing] });
  assert.equal(empty.length, 0, 'il filtro include opportunita non richieste');
  console.log('PASS 2: esclusione opportunita non selezionate');

  const contexts = await leggiContestiOpportunitaPixel({ client, limit: 1, opportunityIds: [target] });
  assert.equal(contexts.length, 1, 'adapter: numero contesti errato');
  assert.equal(Number(contexts[0].pixel_opportunita_id), target, 'adapter: ID inatteso');
  assert(contexts[0].requests.length > 0, 'adapter: richieste mancanti');
  console.log('PASS 3: adapter PIXEL -> POPBUS con filtro, richieste', contexts[0].richiesta_ids);

  const defaultAgain = await leggiOpportunitaPixel({ client, limit: 1000 });
  assert.deepEqual(defaultAgain.map(o => Number(o.pixel_opportunita_id)), ids, 'lettura senza filtro alterata');
  console.log('PASS 4: lettura ordinaria senza filtro invariata');

  await assert.rejects(
    () => leggiOpportunitaPixel({ client, opportunityIds: [] }),
    /opportunityIds non validi/
  );
  await assert.rejects(
    () => leggiOpportunitaPixel({ client, opportunityIds: [target, target] }),
    /opportunityIds non validi/
  );
  console.log('PASS 5: parametri invalidi rifiutati');
  console.log('PIXEL_OPPORTUNITY_FILTER_TEST: 5/5 PASS; dbWrites=0');
} catch (error) {
  failed = true;
  console.error('PIXEL_OPPORTUNITY_FILTER_TEST: FAIL:', error.stack || error);
} finally {
  if (client) {
    try { if (begun) await client.query('ROLLBACK'); }
    catch (error) { failed = true; console.error('ROLLBACK_ERROR:', error); }
    finally { client.release(); }
  }
  await pool.end();
}
if (failed) process.exitCode = 1;
