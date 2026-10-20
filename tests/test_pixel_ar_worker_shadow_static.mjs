// Eseguire da project-root: node tests/test_pixel_ar_worker_shadow_static.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
const worker=fs.readFileSync('services/popbus/v2/worker.js','utf8');
const module=fs.readFileSync('services/popbus/v2/pixel-ar-worker-shadow.js','utf8');
let checks=0;
function check(name,fn){fn();checks++;console.log('PASS '+name);}
check('flag shadow esplicito',()=>assert.match(worker,/POPBUS_PIXEL_AR_WORKER_SHADOW = process\.env\.POPBUS_PIXEL_AR_WORKER_SHADOW === '1'/));
check('branch shadow precede legacy',()=>assert.ok(worker.indexOf('if (POPBUS_PIXEL_AR_WORKER_SHADOW)')<worker.indexOf("if (POPBUS_PIXEL_FIRST) {\n    throw new Error('POPBUS_PIXEL_FIRST_NON_ABILITATO")));
check('worker legacy ancora fail closed',()=>assert.match(worker,/POPBUS_PIXEL_FIRST_NON_ABILITATO/));
check('transazione ripetibile sola lettura',()=>assert.match(module,/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/));
check('rollback garantito',()=>assert.match(module,/if\(transaction\) await client\.query\('ROLLBACK'\)/));
check('opportunita PIXEL persistenti',()=>assert.match(module,/leggiContestiOpportunitaPixel\(/));
check('registro stessa connessione',()=>assert.match(module,/leggiRegistroAr\(\{ client, richiestaIds: allIds \}\)/));
check('fallback A\/R-safe',()=>assert.match(module,/generaFormazioniArSafe\(/));
check('economia ciclo reale',()=>assert.match(module,/valutaEconomiaCiclo\(/));
check('selezione globale',()=>assert.match(module,/eseguiPixelArShadow\(/));
check('nessun filtro margine individuale',()=>assert.doesNotMatch(module,/if\s*\(!economia\.economicamenteAttivabile\)/));
check('nessun SQL di scrittura',()=>assert.doesNotMatch(module,/\b(?:INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|TRUNCATE)\b/i));
check('nessun troncamento proposte',()=>assert.match(module,/proposte oltre limite: nessun troncamento/));
console.log('PIXEL_AR_WORKER_SHADOW_STATIC_JSON:'+JSON.stringify({passed:true,checksPassed:checks,checksTotal:13,scope:'audit statico; NON verifica database, pricing o routing reali'}));
