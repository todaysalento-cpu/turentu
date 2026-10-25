// TURENTU — Diagnostica di compatibilita' persistenza/acceptance fisica PIXEL.
// Salvare come tests/test_popbus_pixel_physical_persistence_compat_shadow.js
// Eseguire: node tests\test_popbus_pixel_physical_persistence_compat_shadow.js
// SOLO LETTURA: legge file JS locali; NON importa moduli produttivi, NON accede al DB.
// ATTENZIONE: questo e' un audit statico di blocchi noti, NON un test E2E DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const dir = 'services/popbus/v2/';
const names = {
  adapter: 'popbus-p0-c8-adapter.js',
  persistence: 'popbus-cycle-persistence.js',
  dbPreflight: 'popbus-multimission-db-preflight.js',
  mono: 'popbus-pixel-acceptance-preflight.js',
  multi: 'popbus-pixel-multi-acceptance-preflight.js'
};
const src = Object.fromEntries(Object.entries(names).map(([k, file]) => {
  try { return [k, readFileSync(resolve(root, dir, file), 'utf8')]; }
  catch (e) { throw Error(`File mancante: ${dir}${file} (${e.code})`); }
}));

let checks = 0;
function check(name, condition) {
  assert.ok(condition, `Contratto sorgente inatteso: ${name}. Fermarsi e riesaminare il modulo.`);
  console.log(`PASS ${++checks} - ${name}`);
}
const contains = (s, pattern) => pattern.test(src[s]);
console.log('=== TURENTU - AUDIT STATICO PERSISTENZA FISICA SHADOW ===');

// Verifiche sul codice ATTUALE, non simulazioni di un'implementazione futura.
check('adapter: missioni estratte tramite indici globali',
  contains('adapter', /plan\.nodes\.slice\(s,\s*e\s*\+\s*1\)/) &&
  contains('adapter', /plan\.legs\.slice\(s,\s*e\)/));
check('adapter: metadati PIXEL non includono nodiTerritoriali',
  contains('adapter', /pixelOpportunitaId:\s*Number\(pix\.pixelOpportunitaId\)/) &&
  !contains('adapter', /nodiTerritoriali\s*:/));
check('persistenza: usa m.nodes come nodi territoriali',
  contains('persistence', /const nodes = m\.nodes\.map/) &&
  contains('persistence', /nodi_territoriali,\s*partenza,\s*arrivo,\s*piano/));
check('persistenza: confronto PIXEL usa nodes della missione',
  contains('persistence', /verificaOpportunitaPixel\(client,\s*m,\s*richieste,\s*nodes\)/));
check('persistenza: JSON piano contiene nodes e legs locali',
  contains('persistence', /JSON\.stringify\(\{\s*nodes,\s*legs:\s*m\.legs/));
check('preflight DB: confronta nodi territoriali con piano globale',
  contains('dbPreflight', /const nodes = db\.nodi_territoriali/) &&
  contains('dbPreflight', /piano\.nodes\[start\s*\+\s*j\]/));
check('acceptance mono: confronta plan.nodes con direttrice PIXEL',
  contains('mono', /plan\.nodes\.map\(integer\)/) &&
  contains('mono', /op\.nodi/));
check('acceptance multi: confronta nodi territoriali con slice fisica globale',
  contains('multi', /const nodes = m\.nodi_territoriali/) &&
  contains('multi', /plan\.nodes\.slice\(start,\s*end\s*\+\s*1\)/));
check('acceptance multi: verifica engine_id PIXEL',
  contains('multi', /m\.corridoio_pixel_id/) &&
  contains('multi', /op\.engine_id/));

console.log(`\nRISULTATO: ${checks}/${checks} controlli statici superati.`);
console.log('DIAGNOSI: INTEGRAZIONE FISICA IN PERSISTENZA/ACCEPTANCE BLOCCATA DAL CONTRATTO ATTUALE.');
console.log('Nessuna scrittura DB; nessuna attivazione LIVE.');
console.log('Prossimo passo: progettare contratto V2 e test con mock PostgreSQL, poi adeguare i moduli.');
