// TURENTU POPBUS V2 — COLLAUDO DB REALE, FASE 1
// Percorso: tests/test_popbus_v2_database.js
// CMD: node tests\test_popbus_v2_database.js
// Opzionale: set POPBUS_DB_ROUTE_TEST=1 && node tests\test_popbus_v2_database.js
// NON modifica tabelle, indici, vincoli o record. NON importa il worker.
// Esegue una transazione PostgreSQL READ ONLY e ROLLBACK finale.
// Il routing opzionale chiama un servizio mappe esterno: potrebbe consumare quote.

import { pool } from '../db/db.js';
import { generaCandidate, generaFormazioniAlternative } from '../services/popbus/v2/model.js';
import { verificaQualitaOccorrenze } from '../services/popbus/v2/service-quality.js';
import { generaRitorniCompatibili } from '../services/popbus/v2/return-matching.js';

const LIMIT = 200;
const ROUTING = process.env.POPBUS_DB_ROUTE_TEST === '1';
const MAX_ROUTES = 5;
const stats = { errors: [], warnings: [], counts: {}, samples: {}, matching: {} };
const log = (tag, data) => console.log(`[${tag}]`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const warn = msg => { stats.warnings.push(msg); log('ATTENZIONE', msg); };
const fail = (tag, e) => { stats.errors.push(`${tag}: ${e.message}`); log('ERRORE', `${tag}: ${e.message}`); };
const num = x => Number(x);
const money = x => Math.round(Number(x) * 100) / 100;
const iso = x => { const t = new Date(x).getTime(); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const fmt = r => ({ id:r.id, start_node_id:r.start_node_id, end_node_id:r.end_node_id, start_datetime:iso(r.start_datetime), classe:r.classe, posti_richiesti:r.posti_richiesti, prezzo:r.prezzo, stato:r.stato });

async function main() {
  let db, transaction = false;
  console.log('\nTURENTU POPBUS V2 — DIAGNOSTICA POSTGRESQL REALE');
  console.log('SOLA LETTURA | NESSUNA MODIFICA SCHEMA | NESSUN RECORD MODIFICATO\n');
  try {
    db = await pool.connect();
    // READ ONLY applicato dal server; blocca INSERT/UPDATE/DELETE/DDL anche in caso di errore nel test.
    await db.query('BEGIN READ ONLY'); transaction = true;
    await db.query("SET LOCAL statement_timeout = '15000ms'");
    await db.query("SET LOCAL lock_timeout = '2000ms'");
    const { rows: info } = await db.query("SELECT current_database() AS db, current_user AS username, current_setting('transaction_read_only') AS read_only, NOW() AS now");
    log('CONNESSIONE', info[0]);
    if (info[0].read_only !== 'on') throw new Error('Transazione non READ ONLY');

    const required = ['richieste_pop_bus','nodi_direttrice','veicolo','disponibilita_veicolo','tariffe','popbus_attivazioni','popbus_attivazione_richieste','direttrici_virtuali','segmenti'];
    const { rows: cols } = await db.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`, [required]);
    const columns = new Map(required.map(t => [t, new Set(cols.filter(c => c.table_name === t).map(c => c.column_name))]));
    const missingTables = required.filter(t => columns.get(t).size === 0);
    if (missingTables.length) warn(`Tabelle non trovate nello schema public: ${missingTables.join(', ')}`);
    for (const table of required) {
      const allowed = columns.get(table);
      if (!allowed.size) continue;
      // Il nome della tabella proviene esclusivamente dalla whitelist hardcoded sopra.
      try {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.${table}`);
        stats.counts[table] = rows[0].n;
      } catch(e) { fail(`COUNT ${table}`,e); }
    }
    log('NUMERO RECORD', stats.counts);

    const requiredRequestCols = ['id','stato','start_datetime','corsa_id','start_node_id','end_node_id','posti_richiesti','prezzo'];
    const missingReq = requiredRequestCols.filter(c => !columns.get('richieste_pop_bus').has(c));
    if (missingReq.length) { warn(`Campi richieste mancanti: ${missingReq.join(', ')}`); return; }

    const { rows: requests } = await db.query(`
      SELECT r.* FROM public.richieste_pop_bus r
      WHERE r.stato='in_attesa' AND r.start_datetime > NOW() AND r.corsa_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.popbus_attivazione_richieste ar
          WHERE ar.richiesta_id=r.id AND ar.attiva
        )
      ORDER BY r.start_datetime,r.id LIMIT $1`, [LIMIT]);
    stats.counts.richieste_ammissibili = requests.length;
    stats.samples.richieste = requests.slice(0,15).map(fmt);
    log('RICHIESTE FUTURE LIBERE', { totale: requests.length, esempi: stats.samples.richieste });
    if (requests.length === LIMIT) warn(`Limite ${LIMIT} raggiunto: il campione potrebbe essere incompleto`);
    if (!requests.length) { warn('Nessuna richiesta futura in_attesa disponibile: servono record con data futura per testare il matching'); return; }

    const ids = [...new Set(requests.flatMap(r => [r.start_node_id,r.end_node_id]).map(num).filter(Number.isInteger))];
    const { rows: nodes } = await db.query(`SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon FROM public.nodi_direttrice WHERE id=ANY($1::int[])`, [ids]);
    const nodeMap = new Map(nodes.map(n => [num(n.id),n]));
    const missingNodes = ids.filter(id => !nodeMap.has(id));
    if (missingNodes.length) warn(`Nodi assenti: ${missingNodes.join(', ')}`);
    const invalid = requests.filter(r => num(r.start_node_id) === num(r.end_node_id) || num(r.posti_richiesti) <= 0 || num(r.prezzo) < 0 || !Number.isFinite(num(r.prezzo)));
    if (invalid.length) warn(`Richieste con campi critici invalidi: ${invalid.map(r => r.id).join(', ')}`);

    const vehicleSql = `SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
      ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
      ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM public.veicolo v
      JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM public.tariffe WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali>0 AND COALESCE(dv.coord,v.coord) IS NOT NULL
      ORDER BY t.euro_km,v.id LIMIT 100`;
    let vehicles = [];
    try { vehicles = (await db.query(vehicleSql)).rows; }
    catch(e) { fail('VEICOLI',e); }
    stats.counts.veicoli_con_tariffa_disponibilita = vehicles.length;
    stats.samples.veicoli = vehicles.slice(0,12).map(v => ({ id:v.id, posti:v.posti_totali, euro_km:v.euro_km, turno_start:iso(v.start), turno_fine:iso(v.fine), manual:v.manual }));
    log('VEICOLI UTILIZZABILI', {totale:vehicles.length, esempi:stats.samples.veicoli});

    let candidates = [];
    try { candidates = generaCandidate(requests,500); }
    catch(e) { fail('CANDIDATE',e); }
    stats.matching.candidate = candidates.length;
    stats.matching.concatenate = candidates.filter(c => c.seeds.length>1).length;
    stats.samples.candidate = candidates.slice(0,20).map(c => ({nodes:c.nodes,seeds:c.seeds,classe:c.classe}));
    log('MATCHING NODI REALI', {candidate:stats.matching.candidate,concatenate:stats.matching.concatenate,esempi:stats.samples.candidate});
    if (!candidates.length) warn('Nessuna candidata generata con le richieste disponibili');

    // Non è una stima di routing: controlla solo concatenazioni esatte di nodi e cronologia.
    const pairs = [];
    for (const a of requests) for (const b of requests) {
      if (num(a.id) === num(b.id) || num(a.end_node_id) !== num(b.start_node_id)) continue;
      const dt = (new Date(b.start_datetime)-new Date(a.start_datetime))/60000;
      if (dt>=0 && dt<=240) pairs.push({prima:a.id,seconda:b.id,nodo:num(a.end_node_id),delta_minuti:Math.round(dt)});
    }
    stats.matching.collegamenti_esatti = pairs.length;
    log('CONCATENAZIONI CRONOLOGICHE (PRELIMINARI)', {totale:pairs.length,esempi:pairs.slice(0,20)});

    if (ROUTING && candidates.length) {
      // Il routing viene eseguito solo su poche candidate, senza cambiare il DB.
      const { pianifica } = await import('../services/popbus/v2/planner.js');
      const samples = candidates.filter(c => c.nodes.every(id => nodeMap.has(num(id)))).slice(0,MAX_ROUTES);
      const results=[];
      for(const c of samples) {
        try {
          const plan = await pianifica(c,nodes);
          const formations = generaFormazioniAlternative(plan,requests,c.seeds,{maxFormazioni:30});
          results.push({seeds:c.seeds,nodes:plan.nodes,km:money(plan.legs.reduce((s,l)=>s+num(l.metres),0)/1000),formazioni:formations.map(f=>({ids:f.requests.map(r=>r.id),peak:f.peak,revenue:f.revenue,departure:iso(f.departure)}))});
        } catch(e) { results.push({seeds:c.seeds,errore:e.message}); }
      }
      stats.matching.routing = results;
      log('ROUTING REALE E FORMAZIONI',results);
    } else {
      warn('Routing stradale NON eseguito (opzionale: POPBUS_DB_ROUTE_TEST=1)');
    }

    // Il matching dei ritorni richiede un piano ciclico cronologico già costruito.
    // Non generiamo un ciclo artificiale e non dichiariamo superata questa fase.
    log('MODULI DISPONIBILI', {
      serviceQuality: typeof verificaQualitaOccorrenze === 'function',
      returnMatching: typeof generaRitorniCompatibili === 'function',
      cicloRealeCostruito: false,
      nota: 'La generazione automatica M1-M2-M3-ritorno e il commit sono oggetto della fase 2'
    });
  } catch(e) { fail('FATALE',e); }
  finally {
    if (db) {
      if (transaction) {
        try { await db.query('ROLLBACK'); log('TRANSAZIONE','ROLLBACK eseguito (nessuna scrittura consentita)'); }
        catch(e) { fail('ROLLBACK',e); }
      }
      db.release();
    }
    try { await pool.end(); } catch(e) { fail('CHIUSURA POOL',e); }
    log('RIEPILOGO',{conteggi:stats.counts,matching:stats.matching,warnings:stats.warnings,errors:stats.errors});
    console.log(`\nESITO: ${stats.errors.length} errori, ${stats.warnings.length} avvisi. Nessun record modificato dal test.`);
    if(stats.errors.length) process.exitCode=1;
  }
}
await main();
