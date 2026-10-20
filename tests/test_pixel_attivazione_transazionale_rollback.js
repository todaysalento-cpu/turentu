// TURENTU — collaudo scrittura relazionale PIXEL -> POPBUS V2, SOLO corse_db.
// Non esegue worker, non invia socket, non cambia stato richieste, non fa COMMIT.
// Tutte le scritture sono in una transazione che termina SEMPRE con ROLLBACK.
// Richiede il modulo popbus-cycle-persistence.js con supporto PIXEL già installato.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = process.cwd();
const fail = m => { throw new Error('PIXEL_ATTIVAZIONE_TX: ' + m); };
if (process.env.POPBUS_PIXEL_TX_CONFIRM !== 'CORSE_DB_ROLLBACK') fail('Conferma mancante');
if (process.env.POPBUS_PIXEL_FIRST === '1') fail('POPBUS_PIXEL_FIRST deve essere 0');
const { pool } = await import(pathToFileURL(resolve(ROOT, 'db/db.js')).href);
const modulePath = resolve(ROOT, 'services/popbus/v2/popbus-cycle-persistence.js');
const source = await readFile(modulePath, 'utf8');
if (!source.includes('verificaOpportunitaPixel') || !source.includes('pixel_opportunita_id'))
  fail('Modulo persistenza PIXEL non presente: non modificare il worker; installare prima il modulo approvato');
const { registraMissioniAttivazione } = await import(pathToFileURL(modulePath).href);
if (typeof registraMissioniAttivazione !== 'function') fail('Export registraMissioniAttivazione assente');
const client = await pool.connect();
let begun = false, id = null, missionIds = [];
try {
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  if (db !== 'corse_db') fail('DB inatteso: ' + db);
  await client.query('BEGIN'); begun = true;
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '25s'");
  await client.query('SELECT pg_advisory_xact_lock(734021, 2)');
  const required = ['popbus_attivazioni','popbus_attivazione_missioni','popbus_missione_richieste','popbus_attivazione_richieste','pixel_opportunita','pixel_direttrici','pixel_opportunita_richieste'];
  const existing = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",[required])).rows.map(x=>x.table_name);
  if (existing.length !== required.length) fail('Tabelle mancanti: '+required.filter(x=>!existing.includes(x)).join(','));
  const opp = (await client.query(`
    SELECT o.id, o.direttrice_id, d.nodi, d.engine_id, d.versione
    FROM pixel_opportunita o JOIN pixel_direttrici d ON d.id=o.direttrice_id
    WHERE o.stato='candidata' AND d.stato='attiva'
      AND cardinality(d.nodi)>=2
      AND EXISTS(SELECT 1 FROM pixel_opportunita_richieste r WHERE r.opportunita_id=o.id)
    ORDER BY o.id LIMIT 1 FOR SHARE OF o,d
  `)).rows[0];
  if (!opp) fail('Nessuna opportunita PIXEL candidata con direttrice attiva: test non eseguito');
  const nodes = opp.nodi.map(Number);
  const assoc = (await client.query('SELECT richiesta_id FROM pixel_opportunita_richieste WHERE opportunita_id=$1 ORDER BY richiesta_id LIMIT 1 FOR SHARE',[opp.id])).rows;
  if (!assoc.length) fail('Associazione PIXEL assente');
  const rid = Number(assoc[0].richiesta_id);
  const vehicle = (await client.query('SELECT id,driver_id FROM veicolo WHERE id=$1',[361])).rows[0];
  if (!vehicle) fail('Veicolo 361 assente');
  const departure = new Date('2026-11-01T13:00:00.000Z');
  const arrival = new Date('2026-11-01T14:00:00.000Z');
  const busyStart = new Date('2026-11-01T12:30:00.000Z');
  const busyEnd = new Date('2026-11-01T14:30:00.000Z');
  // Questa fixture valida la persistenza relazionale, NON la fattibilita stradale.
  // Evita di scrivere se esiste gia una missione/attivazione per la richiesta.
  const occupied = await client.query(`SELECT 1 FROM popbus_attivazione_richieste ar JOIN popbus_attivazioni a ON a.id=ar.attivazione_id WHERE ar.richiesta_id=$1 AND a.stato IN ('in_attesa_autista','confermata') LIMIT 1`,[rid]);
  if (occupied.rowCount) fail('Richiesta gia assegnata; test interrotto');
  const {rows: created} = await client.query(`
    INSERT INTO popbus_attivazioni
      (direttrice_id,pixel_opportunita_id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
    VALUES (NULL,$1,$2,$3,'in_attesa_autista',$4,$5,10,15,1,$6::jsonb,NOW()+INTERVAL '10 minutes') RETURNING id
  `,[opp.id,vehicle.id,vehicle.driver_id,departure,arrival,JSON.stringify({source:'PIXEL',busyStart:busyStart.toISOString(),busyEnd:busyEnd.toISOString(),test:'ROLLBACK_ONLY'})]);
  id = created[0].id;
  const mission = {pixelOpportunitaId:Number(opp.id),pixelDirettriceId:Number(opp.direttrice_id),pixelVersione:Number(opp.versione),
    nodes, legs:Array.from({length:nodes.length-1},(_,i)=>({from:nodes[i],to:nodes[i+1]})),
    departure,arrival,requests:[{id:rid,start:0,end:nodes.length-1}]};
  const global = {nodes,legs:mission.legs,missioni:[{ordine:1,startIndex:0,endIndex:nodes.length-1}],evaluation:{requests:mission.requests}};
  missionIds = await registraMissioniAttivazione(client,{attivazioneId:id,missioni:[mission],pianoGlobale:global});
  const rows = (await client.query(`SELECT a.id, a.direttrice_id,a.pixel_opportunita_id,m.id AS missione_id,m.pixel_opportunita_id AS missione_pixel_id,m.direttrice_id AS missione_direttrice_id,ar.richiesta_id
    FROM popbus_attivazioni a JOIN popbus_attivazione_missioni m ON m.attivazione_id=a.id
    JOIN popbus_attivazione_richieste ar ON ar.attivazione_id=a.id WHERE a.id=$1`,[id])).rows;
  const valid = rows.length===1 && String(rows[0].pixel_opportunita_id)===String(opp.id) &&
    String(rows[0].missione_pixel_id)===String(opp.id) && rows[0].direttrice_id===null &&
    rows[0].missione_direttrice_id===null && Number(rows[0].richiesta_id)===rid && missionIds.length===1;
  console.log('PIXEL_ATTIVAZIONE_TX_JSON:'+JSON.stringify({db,passed:valid,attivazioneId:id,missionIds,
    pixelOpportunitaId:opp.id,veicoloId:vehicle.id,richiestaId:rid,legacyDirettriceCreata:false,
    associazioneUnivocaNelTest:rows.length===1,limiti:['Non certifica fattibilita operativa','Non certifica concorrenza o idempotenza fra transazioni','Non attiva il worker PIXEL-first']}));
  if (!valid) fail('Invarianti relazionali non rispettati');
} catch(e) { console.error('PIXEL_ATTIVAZIONE_TX_ERROR:',e.stack||e.message); process.exitCode=1; }
finally {
  if (begun) {
    try { await client.query('ROLLBACK'); console.log('PIXEL_ATTIVAZIONE_TX_ROLLBACK_OK'); }
    catch(e) { console.error('PIXEL_ATTIVAZIONE_TX_ROLLBACK_ERROR:',e.message);process.exitCode=1; }
  }
  client.release();
  if (id!==null) {
    const verify=await pool.connect();
    try {
      const {rows}=await verify.query('SELECT COUNT(*)::int AS n FROM popbus_attivazioni WHERE id=$1',[id]);
      const passed=rows[0].n===0;
      console.log('PIXEL_ATTIVAZIONE_TX_PERSISTENZA_JSON:'+JSON.stringify({id,assenteDopoRollback:passed,passed}));
      if(!passed) process.exitCode=1;
    } catch(e) {console.error('PIXEL_ATTIVAZIONE_TX_VERIFY_ERROR:',e.message);process.exitCode=1;}
    finally {verify.release();}
  }
  await pool.end();
}
