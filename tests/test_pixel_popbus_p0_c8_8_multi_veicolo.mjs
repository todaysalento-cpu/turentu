// TURENTU P0-C8.8 — diagnostica multi-veicolo, SOLA LETTURA.
// Copiare in tests/test_pixel_popbus_p0_c8_8_multi_veicolo.mjs
// Eseguire: node --env-file=.env tests/test_pixel_popbus_p0_c8_8_multi_veicolo.mjs
// Nessuna chiamata Google/Stripe; nessuna scrittura DB; nessuna direttrice generata.
import { pool } from '../db/db.js';

const GROUPS = [
  { gruppo:'A', partenza:'2026-11-01T13:00:00Z', ids:[196,197,198] },
  { gruppo:'B', partenza:'2026-11-01T13:45:00Z', ids:[199,200,201] },
  { gruppo:'C', partenza:'2026-11-01T14:30:00Z', ids:[202,203,204] },
  { gruppo:'D', partenza:'2026-11-01T15:15:00Z', ids:[205,206,207] }
];
const ROUTE = { commercialSeconds: 1714 + 1901, repositionSeconds: 2856,
  commercialKm: (24459 + 31364)/1000, repositionKm: 53029/1000 };
const cycleSeconds = ROUTE.commercialSeconds + ROUTE.repositionSeconds;
const client = await pool.connect();
let tx = false;
try {
  await client.query('BEGIN TRANSACTION READ ONLY'); tx = true;
  console.log('=== P0-C8.8 / DOMANDA E ASSEGNAZIONI TEMPORALI ===');
  const demand = await client.query(`SELECT id, stato, corsa_id, posti_richiesti, prezzo,
    start_datetime, origine_nodo_territoriale_id AS salita,
    destinazione_nodo_territoriale_id AS discesa
    FROM richieste_pop_bus WHERE id = ANY($1::bigint[]) ORDER BY id`, [GROUPS.flatMap(g=>g.ids)]);
  const byId = new Map(demand.rows.map(r=>[Number(r.id),r]));
  const rows = GROUPS.map(g=>{
    const rr = g.ids.map(id=>byId.get(id));
    return {gruppo:g.gruppo, partenza_utc:g.partenza,
      richieste:rr.filter(Boolean).length, posti:rr.reduce((s,r)=>s+Number(r?.posti_richiesti??0),0),
      ricavo_euro:rr.reduce((s,r)=>s+Number(r?.prezzo??0),0).toFixed(2),
      tutte_in_attesa:rr.every(r=>r?.stato==='in_attesa'&&r.corsa_id==null)};
  });
  console.table(rows);
  const pairs=[];
  for(let i=0;i<GROUPS.length;i++)for(let j=i+1;j<GROUPS.length;j++){
    const gap=(Date.parse(GROUPS[j].partenza)-Date.parse(GROUPS[i].partenza))/1000;
    pairs.push({sequenza:`${GROUPS[i].gruppo}->${GROUPS[j].gruppo}`,
      gap_min:gap/60, tempo_ciclo_min:+(cycleSeconds/60).toFixed(2),
      margine_nominale_min:+((gap-cycleSeconds)/60).toFixed(2),
      fattibile_nominale:gap>=cycleSeconds});
  }
  console.table(pairs);
  console.log('=== VEICOLI / CAPACITA / TITOLARE (NON CONDUCENTE) ===');
  const v = await client.query(`SELECT v.id, v.driver_id AS titolare_flotta, v.posti_totali,
    v.raggio_km, v.localita, v.coord IS NOT NULL AS ha_base
    FROM veicolo v WHERE v.posti_totali >= $1 ORDER BY v.driver_id,v.id LIMIT 200`,
    [Math.max(...rows.map(r=>r.posti))]);
  console.table(v.rows);
  console.log('=== DISPONIBILITA CONFIGURATE PER I VEICOLI CANDIDATI ===');
  const cols = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='disponibilita_veicolo'`);
  const fields = new Set(cols.rows.map(r=>r.column_name));
  const candidate = ['id','veicolo_id','start','fine','giorni_esclusi','inattivita','manuale','attivo']
    .filter(x=>fields.has(x));
  if(fields.has('veicolo_id') && candidate.length){
    const d = await client.query(`SELECT ${candidate.map(x=>'"'+x+'"').join(',')}
      FROM disponibilita_veicolo WHERE veicolo_id = ANY($1::bigint[]) ORDER BY veicolo_id LIMIT 300`,
      [v.rows.map(r=>r.id)]);
    console.dir(d.rows,{depth:4});
  }else console.log('Schema disponibilita non compatibile con la lettura automatica');
  console.log('=== TARIFFE DISPONIBILI (SCHEMA) ===');
  const tariffTables=await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name ILIKE '%tariff%' ORDER BY table_name,ordinal_position`);
  console.table(tariffTables.rows);
  console.log('=== RISULTATO ===');
  console.log(JSON.stringify({richiesteUniche:byId.size,veicoliConCapienza:v.rows.length,
    commercialeKm:ROUTE.commercialKm,riposizionamentoKm:ROUTE.repositionKm,
    tempoCicloMin:+(cycleSeconds/60).toFixed(2),
    nota:'Fattibilita NOMINALE, non matching operativo: mancano routing base-veicolo, turni effettivi, conflitti, tolleranze ed economia.'},null,2));
} catch(e){console.error('FAIL P0-C8.8:',e?.stack??e);process.exitCode=1;}
finally {
  if(tx)try{await client.query('ROLLBACK')}catch(e){console.error('ROLLBACK FAIL',e);process.exitCode=1;}
  client.release(); await pool.end();
  console.log('Transazione terminata senza COMMIT. Nessuna scrittura.');
}
