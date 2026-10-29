/**
 * TURENTU STEP 4.37.26 - preflight NCC/POPBUS/A-R
 * Modalita': sola lettura. Non chiama endpoint di accettazione.
 * Esecuzione: copiare in tests con estensione .mjs e lanciare node tests\test_step_4_37_26_preflight_COMPLETO.mjs
 * Opzionale: impostare TEST_VEICOLO_ID e DATABASE_URL per lettura PostgreSQL reale.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('routes/pending.routes.js');
const service = read('services/booking/vehicle-commitments.service.js');
const routing = read('services/booking/vehicle-routing.service.js');
const checks = [];
function check(name, fn) {
  try { fn(); console.log(`OK ${name}`); checks.push(true); }
  catch (err) { console.error(`KO ${name}: ${err.message}`); checks.push(false); }
}
const accepts = route.slice(route.indexOf("router.post('/:id/accetta'"));
const newCourse = accepts.slice(accepts.indexOf('if (!corsa) {', accepts.indexOf('const primaNccCondivisibile')));
check('route: blocco veicolo presente', () => assert.match(accepts, /await\s+bloccaVeicoloPerAssegnazione\(client,\s*p\.veicolo_id\)/));
check('route: controllo trasferimenti importato', () => assert.match(route, /import\s*\{[^}]*verificaTrasferimentiVeicolo[^}]*\}\s*from\s*['"]\.\.\/services\/booking\/vehicle-commitments\.service\.js['"]/s));
check('route: controllo trasferimenti nella creazione corsa', () => assert.match(newCourse, /await\s+verificaTrasferimentiVeicolo\(\s*client,\s*pRow\.veicolo_id/));
check('route: coordinate NCC verificate', () => assert.match(newCourse, /NCC_MISSION_GEO_INVALID/));
check('route: conflitto gestito con HTTP 409', () => assert.match(accepts, /err\.code\s*===\s*'VEHICLE_COMMITMENT_CONFLICT'\s*\?\s*409/));
check('route: conflitto non rifiuta pending', () => assert.match(accepts, /'VEHICLE_COMMITMENT_CONFLICT'\]\.includes\(err\.code\)/));
check('route: rollback previsto', () => assert.match(accepts, /await\s+client\.query\('ROLLBACK'\)/));
check('route: commit prima delle notifiche', () => {
  const commit = accepts.indexOf("await client.query('COMMIT')");
  const notify = accepts.indexOf('await notifyUser(');
  assert.ok(commit >= 0 && notify > commit);
});
check('route: guardia A/R vincolata', () => assert.match(accepts, /AR_COORDINATED_ACCEPTANCE_REQUIRED/));
check('route: gestione condivisa esistente conservata', () => assert.match(accepts, /NCC_SHARED_COURSE_UNAVAILABLE/));
check('service: lettura impegni NCC POPBUS A/R', () => {
  for (const tag of ["'NCC' AS fonte", "'POPBUS' AS fonte", "'AR_PROVVISORIA' AS fonte"]) assert.ok(service.includes(tag), `manca ${tag}`);
});
check('service: fail closed trasferimenti', () => assert.match(service, /nonVerificabili\.length/));
check('routing: usa accesso stradale PIXEL', () => assert.match(routing, /checkPixelStopRoadAccess/));

if (process.env.TEST_VEICOLO_ID) {
  try {
    const id = Number(process.env.TEST_VEICOLO_ID);
    assert.ok(Number.isSafeInteger(id) && id > 0, 'TEST_VEICOLO_ID non valido');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL non configurato; verifica DB saltata');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const { caricaImpegniVeicolo } = await import(path.join(root, 'services/booking/vehicle-commitments.service.js'));
      const impegni = await caricaImpegniVeicolo(client, id);
      console.log(`DB READ ONLY veicolo ${id}: ${impegni.length} impegni`);
      for (const i of impegni) console.log(JSON.stringify({ fonte:i.fonte, id:i.riferimento_id, stato:i.stato, inizio:i.inizio, fine:i.fine }));
      checks.push(true);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  } catch (err) {
    console.error(`KO DB READ ONLY: ${err.message}`);
    checks.push(false);
  }
} else {
  console.log('DB non interrogato (TEST_VEICOLO_ID non impostato).');
}
const ok = checks.filter(Boolean).length;
console.log(`\nPreflight: ${ok}/${checks.length} controlli superati.`);
console.log('NOTA: controlli statici e opzionale lettura DB; NON e un test end-to-end di accettazione o concorrenza.');
if (ok !== checks.length) process.exitCode = 1;
