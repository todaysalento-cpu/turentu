// TURENTU P0-C8.18A — preflight acceptance multimissione, SOLO LETTURA.
// Salvare in tests/ con estensione .mjs; eseguire node --env-file=.env tests/...
// Nessuna acceptance, Stripe, UPDATE, INSERT, DELETE, COMMIT o chiamata esterna.
import { pool } from '../db/db.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const PASS = msg => console.log('PASS ' + msg);
const WARN = msg => console.log('ATTENZIONE ' + msg);
const qid = s => '"' + s.replaceAll('"', '""') + '"';
const tableNames = ['popbus_attivazioni','offerte_autisti','popbus_attivazione_missioni','popbus_missione_richieste','popbus_attivazione_richieste','richieste_pop_bus','corse','prenotazioni','pagamenti','transazioni_wallet','veicolo','disponibilita_veicolo'];
const ids = [196,197,198,205,206,207];
const file = new URL('../services/popbus/v2/acceptance.js', import.meta.url);
let client;
let tx = false;
let failures = 0;
function check(ok, yes, no) { if (ok) PASS(yes); else { failures++; console.log('FAIL ' + no); } }
try {
  console.log('=== P0-C8.18A / ACCEPTANCE MULTIMISSIONE / READ ONLY ===');
  client = await pool.connect();
  await client.query('BEGIN READ ONLY'); tx = true;
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '1500ms'");

  const cols = await client.query(`SELECT table_name,column_name,data_type,is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
    ORDER BY table_name,ordinal_position`,[tableNames]);
  const byTable = new Map();
  for (const r of cols.rows) { if (!byTable.has(r.table_name)) byTable.set(r.table_name,new Set()); byTable.get(r.table_name).add(r.column_name); }
  for (const t of tableNames) check(byTable.has(t),`Tabella ${t} presente`,`Tabella ${t} mancante`);

  const acceptance = await readFile(file,'utf8');
  const signatures = [
    ['Preflight PIXEL multi','verificaAccettazionePixelMulti'],
    ['Preflight piano multi','validaPianoMultiMissione'],
    ['Persistenza missioni','verificaMissioniPersistite'],
    ['Controllo turno','verificaTurnoVeicolo'],
    ['Fingerprint richieste','fingerprintRichiesta'],
    ['Gate test multimissione','POPBUS_MULTIMISSION_ACCEPTANCE_TEST'],
    ['Validazione pagamenti','verificaPagamento'],
    ['Scrittura prenotazioni','INSERT INTO prenotazioni'],
    ['Scrittura pagamenti','INSERT INTO pagamenti']
  ];
  for (const [label,needle] of signatures) check(acceptance.toLowerCase().includes(needle.toLowerCase()),label+' presente in acceptance.js',label+' NON trovato in acceptance.js');
  const has = (t,c) => byTable.get(t)?.has(c) ?? false;
  if (has('richieste_pop_bus','id')) {
    const fields=['id','stato','corsa_id','cliente_id','payment_intent_id','prezzo','posti_richiesti','start_datetime'].filter(c=>has('richieste_pop_bus',c));
    const rows=await client.query(`SELECT ${fields.map(qid).join(',')} FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[ids]);
    check(rows.rows.length===ids.length,'Sei richieste fixture presenti','Numero richieste fixture inatteso');
    for(const r of rows.rows) {
      const blockers=[];
      if(r.stato!=='in_lavorazione') blockers.push('stato='+r.stato);
      if(r.corsa_id!=null) blockers.push('corsa_id occupato');
      if(!Number.isSafeInteger(Number(r.cliente_id))||Number(r.cliente_id)<=0) blockers.push('cliente_id assente');
      if(!r.payment_intent_id) blockers.push('payment_intent_id assente');
      console.log(`RICHIESTA ${r.id}: ${blockers.length ? 'NON PRONTA — '+blockers.join(', ') : 'prerequisiti principali presenti (pagamento NON verificato)'}`);
    }
  } else WARN('Impossibile ispezionare richieste: colonna id non presente');

  if (has('veicolo','id')) {
    const fields=['id','driver_id','posti_totali'].filter(c=>has('veicolo',c));
    const vehicle=await client.query(`SELECT ${fields.map(qid).join(',')} FROM public.veicolo WHERE id=$1`,[353]);
    check(vehicle.rows.length===1,'Veicolo 353 presente','Veicolo 353 assente');
    if(vehicle.rows.length) console.log('VEICOLO 353: '+JSON.stringify(vehicle.rows[0]));
  }
  if(has('disponibilita_veicolo','veicolo_id')) {
    const shifts=await client.query('SELECT count(*)::int AS n FROM public.disponibilita_veicolo WHERE veicolo_id=$1',[353]);
    console.log(`TURNI veicolo 353: ${shifts.rows[0].n} configurazioni (copertura oraria NON verificata)`);
  }

  const constraints=await client.query(`SELECT c.relname AS tabella, con.conname AS nome, con.contype AS tipo,
    pg_get_constraintdef(con.oid) AS definizione
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    ORDER BY c.relname,con.conname`,[tableNames]);
  console.log('VINCOLI: '+constraints.rows.length+' su tabelle coinvolte');
  for(const r of constraints.rows.filter(x=>['corse','prenotazioni','pagamenti','popbus_attivazioni'].includes(x.tabella)))
    console.log(`  ${r.tabella}.${r.nome}: ${r.definizione}`);

  const triggers=await client.query(`SELECT event_object_table AS tabella,trigger_name,action_timing,event_manipulation
    FROM information_schema.triggers WHERE trigger_schema='public'
    AND event_object_table=ANY($1::text[]) ORDER BY event_object_table,trigger_name`,[tableNames]);
  for(const r of triggers.rows) console.log(`TRIGGER ${r.tabella}.${r.trigger_name}: ${r.action_timing} ${r.event_manipulation}`);

  const sourceGuard = /economicamenteAttivabile/.test(acceptance);
  if (!sourceGuard) WARN('acceptance.js non mostra un controllo testuale diretto economicamenteAttivabile: verificare il gate economico a monte prima di attivazioni reali');
  else PASS('Riferimento economico individuato in acceptance.js (non prova la rivalidazione)');
  console.log('NOTA: nessun pagamento interrogato, nessuna accettazione invocata, nessuna scrittura eseguita.');
} catch (err) { failures++; console.error('ERRORE:',err.stack||err); }
finally {
  if(client) {
    if(tx) { try { await client.query('ROLLBACK'); console.log('ROLLBACK transazione READ ONLY completato'); } catch(e) { console.error('ROLLBACK fallito:',e.message); failures++; } }
    client.release();
  }
  await pool.end();
}
console.log(failures===0 ? 'ESITO: PASS — PRE-FLIGHT STATICO/DB SOLA LETTURA; NON acceptance E2E.' : `ESITO: ${failures} criticita strutturali; NON procedere ad acceptance E2E.`);
if(failures) process.exitCode=1;
