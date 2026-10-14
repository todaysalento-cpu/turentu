/** POPBUS V2 — atomicita' transazionale SHADOW.
 * Usa SOLO tabelle dedicate public.popbus_shadow_atomic_*; NON importa worker/db.js.
 * DATABASE_URL obbligatoria. Non attiva worker, pagamenti o socket.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non impostata. Nessuna connessione tentata.');
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}, max:2, connectionTimeoutMillis:10000});
  const suffix = `${process.pid}_${randomBytes(5).toString('hex')}`;
  const t = {
    richieste:`public.popbus_shadow_atomic_r_${suffix}`,
    attivazioni:`public.popbus_shadow_atomic_a_${suffix}`,
    associazioni:`public.popbus_shadow_atomic_ar_${suffix}`,
    offerte:`public.popbus_shadow_atomic_o_${suffix}`,
  };
  let c, observer, created=[], passed=0;
  const check=(condition,label)=>{if(!condition)throw new Error(`FAIL: ${label}`); console.log(`✅ ${String(++passed).padStart(2,'0')} — ${label}`);};
  const counts=async()=>{
    const out={};
    for(const [k,table] of Object.entries(t)) out[k]=Number((await observer.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    return out;
  };
  const status=async()=> (await observer.query(`SELECT stato FROM ${t.richieste} WHERE id=1`)).rows[0]?.stato;
  const clean=async()=>{ const x=await counts(); return x.richieste===1 && x.attivazioni===0 && x.associazioni===0 && x.offerte===0 && await status()==='in_attesa'; };
  try {
    c=await pool.connect(); observer=await pool.connect();
    const db=(await c.query('SELECT current_database() AS db')).rows[0].db;
    console.log(`🔌 Database: ${db} — atomicita' SHADOW su tabelle dedicate`);
    await c.query(`CREATE TABLE ${t.richieste}(id integer PRIMARY KEY, stato text NOT NULL)`); created.push(t.richieste);
    await c.query(`CREATE TABLE ${t.attivazioni}(id integer PRIMARY KEY, stato text NOT NULL)`); created.push(t.attivazioni);
    await c.query(`CREATE TABLE ${t.associazioni}(attivazione_id integer NOT NULL REFERENCES ${t.attivazioni}(id), richiesta_id integer NOT NULL REFERENCES ${t.richieste}(id), PRIMARY KEY(attivazione_id,richiesta_id))`); created.push(t.associazioni);
    await c.query(`CREATE TABLE ${t.offerte}(id integer PRIMARY KEY, attivazione_id integer NOT NULL REFERENCES ${t.attivazioni}(id))`); created.push(t.offerte);
    await c.query(`INSERT INTO ${t.richieste}(id,stato) VALUES(1,'in_attesa')`);
    check(await clean(),'Schema SHADOW isolato e stato iniziale coerente');

    await c.query('BEGIN');
    await c.query(`SELECT id FROM ${t.richieste} WHERE id=1 FOR UPDATE`);
    await c.query(`INSERT INTO ${t.attivazioni}(id,stato) VALUES(101,'in_attesa_autista')`);
    await c.query(`INSERT INTO ${t.associazioni}(attivazione_id,richiesta_id) VALUES(101,1)`);
    await c.query(`UPDATE ${t.richieste} SET stato='in_lavorazione' WHERE id=1`);
    await c.query(`INSERT INTO ${t.offerte}(id,attivazione_id) VALUES(201,101)`);
    const inside=await c.query(`SELECT stato FROM ${t.richieste} WHERE id=1`);
    check(inside.rows[0].stato==='in_lavorazione','Transazione vede la richiesta modificata');
    const outside=await counts();
    check(outside.attivazioni===0 && outside.associazioni===0 && outside.offerte===0 && await status()==='in_attesa','Seconda connessione non vede scritture non confermate');
    await c.query('ROLLBACK');
    check(await clean(),'ROLLBACK annulla attivazione, associazione, offerta e stato richiesta');

    await c.query('BEGIN');
    await c.query(`INSERT INTO ${t.attivazioni}(id,stato) VALUES(102,'in_attesa_autista')`);
    await c.query(`INSERT INTO ${t.associazioni}(attivazione_id,richiesta_id) VALUES(102,1)`);
    await c.query(`UPDATE ${t.richieste} SET stato='in_lavorazione' WHERE id=1`);
    let expected=false;
    try {await c.query(`INSERT INTO ${t.offerte}(id,attivazione_id) VALUES(202,999999)`);} catch(e){expected=e.code==='23503';}
    check(expected,'Errore FK reale durante creazione offerta (23503)');
    let aborted=false;
    try {await c.query('SELECT 1');}catch(e){aborted=e.code==='25P02';}
    check(aborted,'PostgreSQL impedisce COMMIT operativo implicito dopo errore SQL');
    await c.query('ROLLBACK');
    check(await clean(),'ROLLBACK dopo errore FK elimina ogni scrittura parziale');

    await c.query('BEGIN');
    await c.query(`INSERT INTO ${t.attivazioni}(id,stato) VALUES(103,'in_attesa_autista')`);
    await c.query(`INSERT INTO ${t.associazioni}(attivazione_id,richiesta_id) VALUES(103,1)`);
    await c.query(`UPDATE ${t.richieste} SET stato='in_lavorazione' WHERE id=1`);
    await c.query(`INSERT INTO ${t.offerte}(id,attivazione_id) VALUES(203,103)`);
    await c.query('COMMIT');
    const committed=await counts();
    check(committed.attivazioni===1 && committed.associazioni===1 && committed.offerte===1 && await status()==='in_lavorazione','COMMIT rende persistenti insieme tutte le scritture');
    await c.query('BEGIN');
    await c.query(`DELETE FROM ${t.offerte}`);
    await c.query(`DELETE FROM ${t.associazioni}`);
    await c.query(`DELETE FROM ${t.attivazioni}`);
    await c.query(`UPDATE ${t.richieste} SET stato='in_attesa' WHERE id=1`);
    await c.query('COMMIT');
    check(await clean(),'Ripristino controllato dello stato SHADOW iniziale');
    console.log(`\n${passed}/9 controlli dinamici atomicita' SHADOW superati.`);
    console.log('NON verifica il worker reale, trigger operativi, Socket.IO o Stripe.');
  } catch(e) {
    console.error('❌ TEST FALLITO:',e.stack||e.message);
    process.exitCode=1;
  } finally {
    if(c){try{await c.query('ROLLBACK');}catch{}}
    if(observer){try{await observer.query('ROLLBACK');}catch{}}
    if(c){
      for(const table of [...created].reverse()){
        try{await c.query(`DROP TABLE IF EXISTS ${table}`);}catch(e){console.error(`⚠️ Pulizia fallita per ${table}: ${e.message}`);process.exitCode=1;}
      }
      if(created.length) console.log('🧹 Pulizia tabelle SHADOW tentata.');
    }
    if(c)c.release();if(observer)observer.release();await pool.end();
  }
}
