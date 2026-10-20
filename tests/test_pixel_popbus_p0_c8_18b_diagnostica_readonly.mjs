// TURENTU P0-C8.18B — diagnostica READ ONLY, nessuna acceptance/Stripe/scrittura.
// Copiare in tests/ eliminando .txt. Eseguire con node --env-file=.env.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

const root = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');
const log = (level, msg) => console.log(`${level} ${msg}`);
const fmt = x => JSON.stringify(x);
const paths = {
  acceptance: 'services/popbus/v2/acceptance.js',
  adapter: 'services/popbus/v2/popbus-p0-c8-adapter.js',
  worker: 'services/popbus/v2/worker.js',
  assembler: 'services/popbus/v2/popbus-single-corsa-assembler.js',
  preflight: 'services/popbus/v2/popbus-multimission-preflight.js',
};

console.log('=== P0-C8.18B / ACCEPTANCE PATH AUDIT / READ ONLY ===');
const src = Object.fromEntries(Object.entries(paths).map(([k,v]) => [k, read(v)]));
const checks = [
  ['Adapter richiede economia positiva', /economia\?\.economicamenteAttivabile\s*!==\s*true/.test(src.adapter)],
  ['Acceptance espone funzione di accettazione', /(?:export\s+)?(?:async\s+)?function\s+accettaAttivazione\s*\(/.test(src.acceptance)],
  ['Acceptance chiama preflight PIXEL multi', /verificaAccettazionePixelMulti\s*\(/.test(src.acceptance)],
  ['Acceptance chiama preflight DB missioni', /verificaMissioniPersistite\s*\(/.test(src.acceptance)],
  ['Acceptance usa fingerprint richieste', /fingerprintRichiesta\s*\(/.test(src.acceptance)],
  ['Acceptance controlla disponibilita', /verificaTurnoVeicolo\s*\(/.test(src.acceptance)],
  ['Acceptance verifica pagamenti', /verificaPagamento\s*\(/.test(src.acceptance)],
  ['Acceptance verifica gate multimissione', /POPBUS_MULTIMISSION_ACCEPTANCE_TEST/.test(src.acceptance)],
  ['Assembler aggiunge nodo di attesa', /attesa:\s*true/.test(src.assembler)],
  ['Preflight valida nodi e tempi', /plan\.evaluation\.times/.test(src.preflight)],
];
for (const [name, ok] of checks) log(ok ? 'PASS' : 'ATTENZIONE', name);

// Audit lessicale: NON dimostra l'assenza o la presenza di garanzie nel call graph.
for (const [name, code] of Object.entries({acceptance:src.acceptance,worker:src.worker})) {
  const lines=code.split(/\r?\n/);
  const matches=[];
  lines.forEach((line,i)=>{
    if (/economicamenteAttivabile|preparaCicloPixelPerPersistenza|valutaEconomiaCiclo|accettaAttivazione\s*\(/.test(line))
      matches.push(`${i+1}: ${line.trim().slice(0,200)}`);
  });
  console.log(`AUDIT ${name} — occorrenze economia/adapter/acceptance: ${matches.length}`);
  for (const m of matches.slice(0,35)) console.log('  '+m);
  if(matches.length>35) console.log(`  ...altre ${matches.length-35} occorrenze`);
}
console.log('NOTA: una ricerca testuale non prova che ogni percorso verso acceptance sia protetto dal gate economico.');

const client=await pool.connect();
let inTx=false;
try {
  await client.query('BEGIN READ ONLY'); inTx=true;
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  const vehicle=(await client.query('SELECT id, driver_id, posti_totali FROM veicolo WHERE id=$1',[353])).rows[0];
  assert(vehicle,'Veicolo 353 non presente');
  log('PASS',`Veicolo 353: ${fmt(vehicle)}`);
  const shifts=(await client.query('SELECT * FROM disponibilita_veicolo WHERE veicolo_id=$1 ORDER BY id',[353])).rows;
  console.log(`TURNI ${shifts.length} — campi effettivi (senza interpretare date ricorrenti come scadenza):`);
  for(const s of shifts) console.log('  '+fmt(s));
  const reqs=(await client.query('SELECT id, stato, cliente_id, payment_intent_id, posti_richiesti, prezzo, start_datetime, corsa_id FROM richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id',[[196,197,198,205,206,207]])).rows;
  console.log(`RICHIESTE ${reqs.length}/6:`);
  for(const r of reqs) console.log(`  ${r.id} stato=${r.stato} cliente=${r.cliente_id??'NULL'} payment=${r.payment_intent_id?'PRESENTE':'NULL'} ora=${r.start_datetime} posti=${r.posti_richiesti} prezzo=${r.prezzo}`);
  const dates=['2026-11-01T13:00:00Z','2026-11-01T16:15:15Z'];
  console.log(`INTERVALLO MISSIONI UTC: ${dates.join(' → ')}`);
  console.log('ATTENZIONE: questo intervallo ESCLUDE avvicinamento e ritorno base; la copertura completa NON e verificata.');
  console.log('ATTENZIONE: il turno ricorrente va interpretato con la funzione di produzione, inclusi fuso orario, esclusioni e inattivita.');
  const constraints=(await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='prenotazioni'::regclass AND contype IN ('c','f','u') ORDER BY conname`)).rows;
  console.log(`VINCOLI PRENOTAZIONI (${constraints.length}):`);
  for(const c of constraints) if(/tratta|posti|cliente|corsa/i.test(c.conname+' '+c.definition)) console.log(`  ${c.conname}: ${c.definition}`);
  const trigger=(await client.query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='prenotazioni'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  for(const t of trigger) console.log(`TRIGGER ${t.tgname}: ${t.definition}`);
  await client.query('ROLLBACK'); inTx=false;
  log('PASS','Transazione READ ONLY chiusa con ROLLBACK');
  console.log('ESITO: DIAGNOSTICA COMPLETATA. Non certifica gate economico end-to-end, turno completo, geometria o acceptance.');
} catch(e) {
  console.error('ERRORE:',e.stack??e);
  process.exitCode=1;
} finally {
  if(inTx) { try { await client.query('ROLLBACK'); log('PASS','ROLLBACK di sicurezza'); } catch(e) { console.error('ERRORE ROLLBACK:',e.message); process.exitCode=1; } }
  client.release();
  await pool.end();
}
