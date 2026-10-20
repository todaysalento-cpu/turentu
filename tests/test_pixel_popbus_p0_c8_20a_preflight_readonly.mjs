// TURENTU — P0-C8.20A / CONTRATTO PIXEL-FIRST / READ ONLY
// Diagnostica dello schema e del fixture; nessuna scrittura, nessuna chiamata Stripe.
import { pool } from '../db/db.js';

const checks = [];
let completed = false;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); checks.push({ok,label}); };
const print = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
let client;
let begun = false;
try {
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  begun = true;
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  console.log('=== P0-C8.20A / CONTRATTO PIXEL-FIRST / READ ONLY ===');
  const names = ['pixel_opportunita','pixel_direttrici','popbus_attivazioni','popbus_attivazione_missioni','popbus_missione_richieste','popbus_attivazione_richieste','offerte_autisti','richieste_pop_bus','veicolo','disponibilita_veicolo','tariffe'];
  const schema = await client.query(`SELECT table_name,column_name,is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`,[names]);
  const cols = new Map();
  for (const r of schema.rows) { if(!cols.has(r.table_name))cols.set(r.table_name,new Map()); cols.get(r.table_name).set(r.column_name,r); }
  for (const name of names) check(cols.has(name), `Tabella ${name} presente`);
  const has=(t,c)=>cols.get(t)?.has(c)??false;
  check(has('offerte_autisti','attivazione_id') && cols.get('offerte_autisti')?.get('direttrice_id')?.is_nullable==='YES','Offerta collegabile ad attivazione senza direttrice legacy');
  check(has('popbus_attivazioni','piano') && has('popbus_attivazioni','pixel_opportunita_id') && cols.get('popbus_attivazioni')?.get('direttrice_id')?.is_nullable==='YES','Attivazione PIXEL senza direttrice legacy');
  check(has('popbus_attivazione_missioni','pixel_opportunita_id') && has('popbus_attivazione_missioni','corridoio_pixel_id'),'Missioni con riferimenti PIXEL distinti');
  check(has('popbus_attivazione_richieste','indice_salita') && has('popbus_attivazione_richieste','indice_discesa'),'Mapping globale richieste');
  check(has('popbus_missione_richieste','indice_salita') && has('popbus_missione_richieste','indice_discesa'),'Mapping locale richieste');
  const reqIds=[196,197,198,205,206,207];
  if(cols.has('richieste_pop_bus')) {
    const q=await client.query(`SELECT id,stato,corsa_id,cliente_id,posti_richiesti,prezzo,payment_intent_id,start_datetime FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[reqIds]);
    check(q.rows.length===reqIds.length,'Sei richieste fixture presenti');
    for(const r of q.rows) print(`RICHIESTA ${r.id}`,r);
    const gross=q.rows.reduce((s,r)=>s+Number(r.prezzo??0),0);
    const net=Math.round(gross*85)/100;
    print('RICAVI FIXTURE', {lordoEuro:gross,nettoDopoCommissione15PercentoEuro:net,nota:'Non e un calcolo completo di economia'});
    check(q.rows.every(r=>r.stato==='in_attesa' && r.corsa_id==null),'Fixture non gia convertito');
    const ready=q.rows.every(r=>Number(r.cliente_id)>0 && typeof r.payment_intent_id==='string' && r.payment_intent_id.length>0);
    console.log(`${ready?'PASS':'ATTESO NON PRONTO'} Cliente e riferimento pagamento presenti per acceptance reale`);
  }
  if(cols.has('pixel_opportunita')) {
    const available=[...cols.get('pixel_opportunita').keys()];
    print('COLONNE PIXEL OPPORTUNITA',available);
    const q=await client.query('SELECT * FROM public.pixel_opportunita WHERE id=ANY($1::bigint[]) ORDER BY id',[[118,120]]);
    check(q.rows.length===2,'Opportunita PIXEL 118 e 120 presenti');
    for(const r of q.rows) print(`PIXEL ${r.id}`,r);
  }
  if(cols.has('veicolo')) {
    const q=await client.query('SELECT id,driver_id,posti_totali FROM public.veicolo WHERE id=$1',[353]);
    check(q.rows.length===1 && Number(q.rows[0].posti_totali)>=2,'Veicolo 353 presente e capienza minima fixture');
    if(q.rows[0])print('VEICOLO',q.rows[0]);
  }
  if(cols.has('tariffe')) {
    const q=await client.query("SELECT tipo,euro_km FROM public.tariffe WHERE veicolo_id=$1 ORDER BY tipo",[353]);
    print('TARIFFE 353',q.rows);
    const std=q.rows.filter(r=>r.tipo==='standard'&&Number(r.euro_km)>0).map(r=>Number(r.euro_km));
    if(std.length) {
      const km=164.675, ricavi=60, rate=Math.min(...std);
      const cost=Number((km*rate).toFixed(2));
      const net=Number((ricavi*.85).toFixed(2));
      print('LIMITE INFERIORE ECONOMICO INDICATIVO',{kmCommercialiETrasferimenti:km,euroKmStandard:rate,costoPrimaDiAvvicinamentoRitornoAttesaEuro:cost,ricavoNettoCommissione15Euro:net,margineMassimoPrimaDeiCostiOmissiEuro:Number((net-cost).toFixed(2)),nota:'Non sostituisce valutaEconomiaCiclo; verifica tariffa effettiva e classi'});
      check(net-cost<0,'Fixture 118+120 non attivabile alle ipotesi economiche indicate');
    } else console.log('ATTENZIONE Tariffa standard non disponibile: nessuna conclusione economica');
  }
  console.log('CONTRATTO DA IMPLEMENTARE: lock opportunita PIXEL + lock richieste + lock veicolo + preflight turni/conflitti + routing verificato + ricalcolo economia + persistenza missioni/mapping/offerta nella stessa transazione; fail-closed.');
  console.log('NON VALIDATO: concorrenza reale, turni ricorrenti, routing live, pagamenti, acceptance E2E, transazione di scrittura.');
  completed = true;
} catch(e) { console.error('ERRORE',e.stack??e); process.exitCode=1; }
finally {
  if(client) { if(begun) {try {await client.query('ROLLBACK');console.log('ROLLBACK READ ONLY completato');}catch(e){console.error('ROLLBACK ERROR',e.message);process.exitCode=1;}} client.release(); }
  await pool.end();
  if(!completed || checks.some(c=>!c.ok))process.exitCode=1;
  console.log(`ESITO: ${checks.filter(c=>c.ok).length} PASS, ${checks.filter(c=>!c.ok).length} FAIL — ${completed ? 'COMPLETATO' : 'INCOMPLETO / ERRORE'}`);
}
