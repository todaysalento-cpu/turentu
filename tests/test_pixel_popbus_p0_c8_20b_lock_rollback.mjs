// TURENTU P0-C8.20B — test di lock concorrenti; TRANSAZIONI SENZA DML, ROLLBACK SEMPRE.
// Nessun INSERT/UPDATE/DELETE, nessuna API esterna, nessuna chiamata Stripe.
import { pool } from '../db/db.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';

const reqIds = [196,197,198,205,206,207];
const opportunityIds = [118,120];
const vehicleId = 353;
const checks = [];
const check = (ok, label) => { checks.push({ok,label}); console.log(`${ok?'PASS':'FAIL'} ${label}`); if (!ok) throw Error(label); };
let owner, contender, ownerStarted = false, contenderStarted = false, completed = false;
const configure = async c => {
  await c.query("SET LOCAL statement_timeout = '10000ms'");
  await c.query("SET LOCAL lock_timeout = '1200ms'");
  await c.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
};
try {
  console.log('=== P0-C8.20B / LOCK PIXEL-FIRST / ROLLBACK OBBLIGATORIO ===');
  owner = await pool.connect();
  contender = await pool.connect();
  await owner.query('BEGIN'); ownerStarted = true; await configure(owner);
  await contender.query('BEGIN'); contenderStarted = true; await configure(contender);
  // Ordine fisso: opportunita, veicolo, richieste; lock di riga acquisiti senza modifiche.
  const opp = await owner.query('SELECT id, direttrice_id, stato FROM public.pixel_opportunita WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [opportunityIds]);
  check(opp.rows.length === 2 && opp.rows.every(r=>r.stato==='candidata'), 'Opportunita PIXEL 118/120 bloccate e candidate');
  const vehicle = await owner.query('SELECT id, driver_id, posti_totali FROM public.veicolo WHERE id=$1 FOR UPDATE', [vehicleId]);
  check(vehicle.rows.length===1 && Number(vehicle.rows[0].posti_totali)>=2, 'Veicolo 353 bloccato');
  const requests = await owner.query('SELECT id, stato, corsa_id, cliente_id, payment_intent_id, posti_richiesti, prezzo FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE', [reqIds]);
  check(requests.rows.length===6 && requests.rows.every(r=>r.stato==='in_attesa' && r.corsa_id==null), 'Sei richieste bloccate e ancora disponibili');
  check(new Set(requests.rows.map(r=>Number(r.id))).size===6, 'Richieste senza duplicati');
  const gross = requests.rows.reduce((s,r)=>s+Number(r.prezzo),0);
  const tariff = await owner.query("SELECT MIN(euro_km) AS euro_km FROM public.tariffe WHERE veicolo_id=$1 AND tipo='standard' AND euro_km>0", [vehicleId]);
  const euroKm = Number(tariff.rows[0]?.euro_km);
  check(Number.isFinite(euroKm) && euroKm>0 && Number.isFinite(gross), 'Tariffa standard e ricavi disponibili');
  // Lower bound del costo: 2 missioni (55.823 km ciascuna) + trasferimento (53.029 km).
  // Avvicinamento e ritorno base sono omessi SOLO per dimostrare uno scarto sicuro.
  const econ = valutaEconomiaCiclo({
    ricaviRichiesteEuro: requests.rows.map(r=>Number(r.prezzo)),
    kmAvvicinamento:0, kmMissioni:111.646, kmTrasferimenti:53.029,
    kmRitornoBase:0, euroKm,
  });
  console.log('ECONOMIA LIMITE INFERIORE:', JSON.stringify({ricaviLordi:gross,tariffaEuroKm:euroKm,economicamenteAttivabile:econ.economicamenteAttivabile,centesimi:econ.centesimi,nota:'Avvicinamento/ritorno=0 soltanto per dimostrare scarto; non e validazione completa'}));
  check(econ.economicamenteAttivabile===false, 'Gate economico: fixture respinto anche senza avvicinamento e ritorno');
  console.log('ACCEPTANCE NON PRONTA:', JSON.stringify({senzaCliente:requests.rows.filter(r=>!r.cliente_id).length,senzaPagamento:requests.rows.filter(r=>!r.payment_intent_id).length}));
  // NOWAIT sulla seconda connessione: 55P03 dimostra contesa di riga, non l'intera serializzabilita del worker.
  for (const [label,sql,args] of [
    ['opportunita PIXEL','SELECT id FROM public.pixel_opportunita WHERE id=$1 FOR UPDATE NOWAIT',[118]],
    ['veicolo','SELECT id FROM public.veicolo WHERE id=$1 FOR UPDATE NOWAIT',[vehicleId]],
    ['richiesta','SELECT id FROM public.richieste_pop_bus WHERE id=$1 FOR UPDATE NOWAIT',[196]],
  ]) {
    const savepoint = `sp_${label==='opportunita PIXEL'?'opp':label==='veicolo'?'vehicle':'req'}`;
    await contender.query(`SAVEPOINT ${savepoint}`);
    let blocked = false;
    try { await contender.query(sql,args); }
    catch(e) { if(e.code==='55P03') blocked=true; else throw e; }
    await contender.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    check(blocked, `Concorrenza NOWAIT: ${label} non acquisibile mentre bloccata`);
  }
  console.log('NON VALIDATO: disponibilita ricorrente, conflitti missioni/corse, routing live, economia completa, persistenza, pagamenti, acceptance E2E.');
  completed=true;
} catch(e) { console.error('ERRORE:',e.stack??e); process.exitCode=1; }
finally {
  for(const [label,c,started] of [['contender',contender,contenderStarted],['owner',owner,ownerStarted]]) {
    if(!c) continue;
    if(started) { try {await c.query('ROLLBACK');console.log(`ROLLBACK ${label} completato`);} catch(e){console.error(`ROLLBACK ${label} FALLITO:`,e.message);process.exitCode=1;} }
    c.release(true);
  }
  try {await pool.end();}catch(e){console.error('POOL END:',e.message);process.exitCode=1;}
  if(!completed) process.exitCode=1;
  console.log(`ESITO: ${checks.filter(c=>c.ok).length} PASS, ${checks.filter(c=>!c.ok).length} FAIL — ${completed?'COMPLETATO':'INCOMPLETO'}`);
}
