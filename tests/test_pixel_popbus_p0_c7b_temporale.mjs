/**
 * TURENTU P0-C7B.5 - verifica temporale diagnostica, READ ONLY.
 * Salva come tests/test_pixel_popbus_p0_c7b_temporale.mjs
 * Non chiama Google, Stripe o accettaAttivazione; non modifica il database.
 * Il margine di 30 minuti e' una IPOTESI DI TEST, non una regola certificata.
 */
import { pool } from '../db/db.js';

const OP_IDS = [115, 117];
const REQUEST_IDS = [196, 205];
const TRANSFER_SECONDS = 1646; // P0-C7B.4: routing Google reale 5 -> 8
const TEST_TOLERANCE_MIN = 30;
const fmt = ms => new Date(ms).toISOString();
const minutes = ms => (ms / 60000).toFixed(2);
const num = x => Number(x);
let failures = 0;
function check(condition, label, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ' | ' + detail : ''}`);
  if (!condition) failures++;
}
const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='12000ms'");
  await client.query("SET LOCAL lock_timeout='2000ms'");
  console.log('=== P0-C7B.5 / FATTIBILITA TEMPORALE DIAGNOSTICA ===');
  console.log(`Riposizionamento 5->8: ${TRANSFER_SECONDS}s (P0-C7B.4)`);
  console.log(`Tolleranza desiderata +/- ${TEST_TOLERANCE_MIN} min (solo diagnostica)`);

  const { rows: opps } = await client.query(`
    SELECT o.id, o.inizio_finestra, o.fine_finestra, o.stato,
           d.id AS direttrice_id, d.nodi, d.legs, d.versione
    FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
    WHERE o.id=ANY($1::bigint[]) ORDER BY o.id`, [OP_IDS]);
  const { rows: reqs } = await client.query(`
    SELECT r.id, r.start_datetime, r.stato, r.posti_richiesti,
           r.origine_nodo_territoriale_id AS nodo_partenza,
           r.destinazione_nodo_territoriale_id AS nodo_arrivo,
           por.opportunita_id
    FROM public.richieste_pop_bus r
    JOIN public.pixel_opportunita_richieste por ON por.richiesta_id=r.id
    WHERE r.id=ANY($1::bigint[]) AND por.opportunita_id=ANY($2::bigint[])
    ORDER BY r.id,por.opportunita_id`, [REQUEST_IDS, OP_IDS]);
  check(opps.length===2, 'opportunita PIXEL 115/117 presenti', `${opps.length}/2`);
  check(reqs.some(r=>num(r.id)===196 && num(r.opportunita_id)===115), 'associazione 196 -> 115');
  check(reqs.some(r=>num(r.id)===205 && num(r.opportunita_id)===117), 'associazione 205 -> 117');
  if (failures) throw new Error('Prerequisiti PIXEL mancanti');

  const o1=opps.find(o=>num(o.id)===115), o2=opps.find(o=>num(o.id)===117);
  const r1=reqs.find(r=>num(r.id)===196 && num(r.opportunita_id)===115);
  const r2=reqs.find(r=>num(r.id)===205 && num(r.opportunita_id)===117);
  check(o1.direttrice_id===o2.direttrice_id, 'stessa direttrice');
  check([o1,o2].every(o=>Array.isArray(o.nodi) && o.nodi.map(num).join(',')==='8,5'), 'missioni territoriali 8->5');
  check([r1,r2].every(r=>num(r.nodo_partenza)===8 && num(r.nodo_arrivo)===5), 'salita al nodo 8, discesa al nodo 5');
  const dur = o => Array.isArray(o.legs) ? o.legs.reduce((s,l)=>s+Number(l.seconds),0) : NaN;
  const s1=dur(o1), s2=dur(o2);
  check(Number.isFinite(s1) && s1>0 && Number.isFinite(s2) && s2>0, 'durate PIXEL positive', `${s1}s / ${s2}s`);
  const tol=TEST_TOLERANCE_MIN*60000;
  const interval = (o,r) => {
    const winStart=new Date(o.inizio_finestra).getTime();
    const winEnd=new Date(o.fine_finestra).getTime();
    const requested=new Date(r.start_datetime).getTime();
    return { lo:Math.max(winStart,requested-tol), hi:Math.min(winEnd,requested+tol),
             winStart,winEnd,requested };
  };
  const a=interval(o1,r1), b=interval(o2,r2);
  for (const [o,r,x] of [[o1,r1,a],[o2,r2,b]]) {
    console.log(`\nPIXEL ${o.id} / richiesta ${r.id}`);
    console.log(`Finestra PIXEL: ${fmt(x.winStart)} -> ${fmt(x.winEnd)}`);
    console.log(`Orario desiderato: ${fmt(x.requested)}`);
    if (x.lo<=x.hi) console.log(`Intersezione DIAGNOSTICA: ${fmt(x.lo)} -> ${fmt(x.hi)}`);
    check(x.lo<=x.hi, `intersezione finestra/orario richiesta ${r.id}`);
  }
  if (a.lo>a.hi || b.lo>b.hi || !Number.isFinite(s1+s2)) throw new Error('Nessuna finestra diagnostica valida');
  const move1=s1*1000, transfer=TRANSFER_SECONDS*1000, move2=s2*1000;
  // Una partenza t1 e' possibile se t1 in A e t2 in B, con t2 >= t1+move1+transfer.
  const t1=a.lo;
  const arrival1=t1+move1;
  const transferEnd=arrival1+transfer;
  const t2=Math.max(b.lo,transferEnd);
  const arrival2=t2+move2;
  const wait=t2-transferEnd;
  console.log('\n=== SEQUENZA CANDIDATA (NON ATTIVAZIONE) ===');
  console.log(`Missione 1 partenza nodo 8: ${fmt(t1)}`);
  console.log(`Missione 1 arrivo nodo 5:   ${fmt(arrival1)}`);
  console.log(`Riposizionamento 5->8 fino: ${fmt(transferEnd)}`);
  console.log(`Sosta al nodo 8:             ${minutes(wait)} min`);
  console.log(`Missione 2 partenza nodo 8: ${fmt(t2)}`);
  console.log(`Missione 2 arrivo nodo 5:   ${fmt(arrival2)}`);
  console.log(`Tempo complessivo ciclo:    ${minutes(arrival2-t1)} min`);
  check(t2<=b.hi, 'seconda partenza nella finestra diagnostica', `limite=${fmt(b.hi)}`);
  check(wait>=0, 'nessuna sovrapposizione tra trasferimento e seconda missione');
  check(t2>=transferEnd, 'riposizionamento concluso prima della salita 2');
  console.log(`Margine prima del termine finestra 2: ${minutes(b.hi-t2)} min`);

  console.log('\n=== DISPONIBILITA VEICOLI (ISPEZIONE, NON VALIDAZIONE TURNO) ===');
  const {rows: vehicles}=await client.query(`
    SELECT v.id, v.driver_id, v.posti_totali,
           (SELECT count(*)::int FROM public.disponibilita_veicolo dv WHERE dv.veicolo_id=v.id) AS configurazioni
    FROM public.veicolo v
    WHERE v.posti_totali >= $1
    ORDER BY v.id LIMIT 20`, [Math.max(num(r1.posti_richiesti),num(r2.posti_richiesti))]);
  for(const v of vehicles) {
    console.log(`veicolo=${v.id} titolare=${v.driver_id} posti=${v.posti_totali} configurazioni=${v.configurazioni}`);
  }
  check(vehicles.some(v=>v.configurazioni>0), 'almeno un veicolo con disponibilita configurata');
  console.log('\nATTENZIONE: presenza di configurazione NON equivale a turno valido.');
  console.log('ATTENZIONE: non verificati tempi di avvicinamento, ritorno alla base, conflitti e regole di pickup effettive.');
  console.log('ATTENZIONE: l\'attivazione reale richiede verificaTurnoVeicolo e preflight acceptance.');
  console.log(`\nESITO: ${failures===0 ? 'PASS DIAGNOSTICO' : 'FAIL'} | controlli falliti=${failures}`);
  if(failures) process.exitCode=1;
} catch(err) {
  console.error('ERRORE P0-C7B.5:',err.message);
  process.exitCode=1;
} finally {
  try { await client.query('ROLLBACK'); console.log('ROLLBACK READ ONLY eseguito.'); }
  catch(err) { console.error('ERRORE ROLLBACK:',err.message); process.exitCode=1; }
  client.release();
  await pool.end();
}
