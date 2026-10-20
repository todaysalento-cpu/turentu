// TURENTU PIXEL — audit puntuale associazioni SQL e gruppi temporali (ROLLBACK).
// Solo test manuale: BEGIN + ROLLBACK SEMPRE; non tocca worker, pagamenti o missioni.
// PREREQUISITO: pixel.persistence.service.js deve supportare `client` esterno
// sia in pubblicaOpportunitaPixel sia in leggiOpportunitaPixel.
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';

const assert = (v, m) => { if (!v) throw new Error(`PIXEL DOMANDA DINAMICA ROLLBACK: ${m}`); };
const NODES = [8, 5, 7];
const date = new Date(Date.now() + 14 * 86400000);
date.setUTCHours(9, 0, 0, 0);
let client;
let inTx = false;
let failed = false;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  inTx = true;
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '10s'");
  // Blocca subito un servizio di persistenza non transazionale: mai pubblicare fuori dal client del test.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../services/pixel/pixel.persistence.service.js', import.meta.url), 'utf8');
  assert(/client\s*:\s*externalClient/.test(src) && /externalClient\s*\?\?\s*await\s+pool\.connect/.test(src),
    'il servizio non supporta client transazionale esterno: installare la versione aggiornata PRIMA del test');
  assert(/client\s*=\s*null/.test(src), 'leggiOpportunitaPixel deve accettare client esterno');

  const nodeRows = (await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali WHERE id=ANY($1::bigint[]) AND attivo=TRUE`, [NODES])).rows;
  assert(nodeRows.length === 3, 'servono i nodi territoriali attivi 8, 5, 7');
  const nodeMap = new Map(nodeRows.map(n => [Number(n.id), { ...n, lat: Number(n.lat), lon: Number(n.lon) }]));
  const road = async ids => {
    const legs = [];
    for (let i = 1; i < ids.length; i++) {
      const r = await leg(nodeMap.get(Number(ids[i - 1])), nodeMap.get(Number(ids[i])));
      assert(r && r.metres > 0 && r.seconds > 0 && typeof r.polyline === 'string' && r.polyline.length,
        `routing non verificato ${ids[i - 1]} -> ${ids[i]}`);
      legs.push({ metres: r.metres, seconds: r.seconds, polyline: r.polyline, roadCoincident: false });
    }
    return { verificataRouting: true, legs };
  };
  const first = await leg(nodeMap.get(8), nodeMap.get(5));
  assert(first && first.seconds > 0, 'routing iniziale assente');
  const cases = [
    { a: 8, b: 5, at: date, prezzo: 7 },
    { a: 5, b: 7, at: new Date(date.getTime() + Math.round(first.seconds) * 1000), prezzo: 9 },
    { a: 8, b: 7, at: date, prezzo: 14 }
  ];
  const requestIds = [];
  for (const c of cases) {
    const a = nodeMap.get(c.a), b = nodeMap.get(c.b);
    const r = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (origine,destinazione,origine_nodo_territoriale_id,destinazione_nodo_territoriale_id,
         origine_address,destinazione_address,start_datetime,posti_richiesti,stato,classe,prezzo)
      VALUES (ST_SetSRID(ST_MakePoint($1,$2),4326), ST_SetSRID(ST_MakePoint($3,$4),4326),
              $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10) RETURNING id`,
      [a.lon,a.lat,b.lon,b.lat,c.a,c.b,a.nome,b.nome,c.at,c.prezzo]);
    requestIds.push(Number(r.rows[0].id));
  }
  console.log('RICHIESTE NON CONFERMATE:', requestIds);
  const requests = (await client.query(`
    SELECT * FROM public.richieste_pop_bus WHERE id=ANY($1::integer[]) ORDER BY id`, [requestIds])).rows;

  async function publishAll(engine) {
    const out = [];
    for (const c of engine.listCorridors()) {
      const r = await pubblicaOpportunitaPixel({ engine, direttriceId: c.id, bufferMinuti: 0, client });
      out.push({ nodes: c.nodes, ...r });
    }
    return out;
  }
  async function snapshot() {
    const d = (await client.query(`SELECT engine_id, versione, nodi, legs, stato
      FROM public.pixel_direttrici ORDER BY engine_id, versione`)).rows;
    const o = (await client.query(`SELECT d.engine_id, o.id, o.stato, o.dati_temporali->>'fingerprint' AS fingerprint,
      ARRAY(SELECT r.richiesta_id FROM public.pixel_opportunita_richieste r
            WHERE r.opportunita_id=o.id ORDER BY r.richiesta_id) AS richieste
      FROM public.pixel_opportunita o JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
      ORDER BY d.engine_id, o.id`)).rows;
    return { d, o };
  }
  // Audit indipendente: confronta ogni opportunita candidata SQL con le istanze
  // temporali effettive prodotte dal motore PIXEL per la stessa direttrice.
  async function verificaAssociazioni(engine, fase) {
    const expected = new Map();
    for (const c of engine.listCorridors()) {
      const key = `territorial:${c.nodes.join('>')}`;
      const groups = await engine.temporalCandidatesCompleteWithReturns(c.id, { bufferMinuti: 0 });
      const signatures = groups.map(g => {
        assert(Array.isArray(g.richiestaIds) && g.richiestaIds.length > 0, `${fase}: gruppo senza richieste ${key}`);
        const ids = g.richiestaIds.map(Number).sort((a,b) => a-b);
        assert(ids.every(id => c.richiestaIds.includes(id)), `${fase}: gruppo non associato territorialmente ${key}`);
        assert(Number.isFinite(g.finestraPartenza?.inizioMs) && Number.isFinite(g.finestraPartenza?.fineMs),
          `${fase}: finestra temporale non valida ${key}`);
        return JSON.stringify({ ids, start: g.finestraPartenza.inizioMs, end: g.finestraPartenza.fineMs });
      }).sort();
      expected.set(key, signatures);
    }
    const { rows } = await client.query(`
      SELECT d.engine_id, o.id, o.stato, o.inizio_finestra, o.fine_finestra,
             ARRAY(SELECT r.richiesta_id FROM public.pixel_opportunita_richieste r
                   WHERE r.opportunita_id=o.id ORDER BY r.richiesta_id) AS richiesta_ids
      FROM public.pixel_opportunita o
      JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
      WHERE d.stato='attiva' AND o.stato='candidata'
      ORDER BY d.engine_id, o.id`);
    const actual = new Map();
    for (const row of rows) {
      const ids = row.richiesta_ids.map(Number);
      assert(ids.length > 0 && new Set(ids).size === ids.length, `${fase}: associazioni vuote/duplicate opportunita ${row.id}`);
      const signature = JSON.stringify({ ids, start: new Date(row.inizio_finestra).getTime(),
        end: new Date(row.fine_finestra).getTime() });
      if (!actual.has(row.engine_id)) actual.set(row.engine_id, []);
      actual.get(row.engine_id).push(signature);
    }
    assert(rows.length === [...expected.values()].reduce((n, a) => n + a.length, 0),
      `${fase}: numero opportunita candidate SQL diverso dalle istanze PIXEL`);
    for (const [key, signatures] of expected) {
      const found = (actual.get(key) ?? []).sort();
      assert(JSON.stringify(found) === JSON.stringify(signatures),
        `${fase}: associazioni/finestre incoerenti ${key}\nAtteso: ${JSON.stringify(signatures)}\nSQL: ${JSON.stringify(found)}`);
    }
    for (const key of actual.keys()) assert(expected.has(key), `${fase}: direttrice candidata inattesa ${key}`);
    const popbus = await leggiOpportunitaPixel({ limit: 1000, client });
    assert(popbus.length === rows.length, `${fase}: POPBUS legge opportunita diverse dalle candidate SQL`);
    const byId = new Map(rows.map(r => [String(r.id), r]));
    for (const o of popbus) {
      const db = byId.get(String(o.pixel_opportunita_id));
      assert(db, `${fase}: POPBUS legge opportunita non candidata ${o.pixel_opportunita_id}`);
      assert(JSON.stringify(o.richiesta_ids.map(Number).sort((a,b)=>a-b)) ===
        JSON.stringify(db.richiesta_ids.map(Number)), `${fase}: richieste POPBUS incoerenti ${db.id}`);
    }
    console.log('AUDIT ASSOCIAZIONI OK:', { fase, opportunitaCandidate: rows.length,
      direttrici: expected.size, associazioni: rows.reduce((n,r)=>n+r.richiesta_ids.length,0) });
  }

  const engine1 = createIncrementalCorridorEngine({ routeNodes: road, abilitaVariantiP1: true });
  for (const r of requests) await engine1.processRequest(r);
  const composed = engine1.listCorridors().find(c => c.nodes.join('>') === '8>5>7');
  assert(composed && requestIds.every(id => composed.richiestaIds.includes(id)), 'direttrice composta non valida');
  const published1 = await publishAll(engine1);
  const snap1 = await snapshot();
  await verificaAssociazioni(engine1, 'baseline');
  assert(snap1.d.some(d => d.engine_id === 'territorial:8>5>7'), 'direttrice SQL non pubblicata');
  const read1 = await leggiOpportunitaPixel({ limit: 1000, client });
  assert(read1.some(o => o.nodi.map(Number).join('>') === '8>5>7' &&
    requestIds.every(id => o.richiesta_ids.map(Number).includes(id))), 'POPBUS non legge opportunita composta');
  console.log('PRIMA PUBBLICAZIONE:', { direttrici: snap1.d.length, opportunita: snap1.o.length, visibiliPopbus: read1.length, published1 });

  // Simula il riavvio: ricostruisce il motore SOLO da catalogo SQL e richieste correnti.
  const active = (await client.query(`SELECT engine_id, versione, nodi, legs FROM public.pixel_direttrici
    WHERE stato='attiva' ORDER BY engine_id, versione DESC`)).rows;
  const seen = new Set();
  const initialCorridors = active.map((d, i) => {
    assert(!seen.has(d.engine_id), `versioni attive duplicate ${d.engine_id}`);
    seen.add(d.engine_id);
    assert(d.engine_id === `territorial:${d.nodi.join('>')}`, 'identita territoriale incoerente');
    return { id: `px-${i + 1}`, nodes: d.nodi.map(Number), legs: d.legs,
      richiestaIds: [], versione: Number(d.versione) };
  });
  const engine2 = createIncrementalCorridorEngine({ routeNodes: road, initialCorridors, abilitaVariantiP1: true });
  for (const r of requests) await engine2.processRequest(r);
  await publishAll(engine2);
  const snap2 = await snapshot();
  assert(JSON.stringify(snap1) === JSON.stringify(snap2),
    'seconda pubblicazione non idempotente (direttrici/opportunita/associazioni mutate)');
  console.log('BASELINE OK:', { richieste: requestIds.length, direttrici: snap2.d.length,
    opportunita: snap2.o.length, riavvio: true, idempotenza: true });

  // Mutazione domanda: richiesta B viene spostata di 6 ore.
  // PIXEL mantiene il catalogo territoriale ma deve ricalcolare le istanze.
  const originalB = cases[1].at;
  const movedB = new Date(originalB.getTime() + 6 * 3600000);
  await client.query(`UPDATE public.richieste_pop_bus SET start_datetime=$1 WHERE id=$2`,
    [movedB, requestIds[1]]);

  async function rebuildFromSql() {
    const rows = (await client.query(`SELECT engine_id, versione, nodi, legs
      FROM public.pixel_direttrici WHERE stato='attiva'
      ORDER BY engine_id, versione DESC`)).rows;
    const restored = rows.map((d, i) => {
      assert(d.engine_id === `territorial:${d.nodi.join('>')}`, 'engine_id incoerente');
      return { id: `px-${i + 1}`, nodes: d.nodi.map(Number), legs: d.legs,
        richiestaIds: [], versione: Number(d.versione) };
    });
    const current = (await client.query(`SELECT * FROM public.richieste_pop_bus
      WHERE id=ANY($1::integer[]) ORDER BY id`, [requestIds])).rows;
    const e = createIncrementalCorridorEngine({routeNodes: road,
      initialCorridors: restored, abilitaVariantiP1: true});
    for (const r of current) await e.processRequest(r);
    return e;
  }
  const engineMoved = await rebuildFromSql();
  await publishAll(engineMoved);
  const movedSnap = await snapshot();
  await verificaAssociazioni(engineMoved, 'orario_spostato');
  const activeMoved = await leggiOpportunitaPixel({limit:1000,client});
  const activeIds = new Set(activeMoved.map(o => String(o.pixel_opportunita_id)));
  assert(activeMoved.some(o => o.nodi.map(Number).join('>') === '8>5>7'),
    'direttrice composta non leggibile dopo cambio orario');
  assert(movedSnap.o.some(o => o.stato === 'superata'),
    'nessuna opportunita storica superata dopo mutazione temporale');
  for (const o of movedSnap.o) {
    if (o.stato === 'superata') assert(!activeIds.has(String(o.id)),
      `opportunita superata ${o.id} ancora visibile a POPBUS`);
  }
  assert(movedSnap.d.length === snap2.d.length,
    'cambio orario ha modificato il numero delle direttrici territoriali');
  assert(JSON.stringify(movedSnap.d) === JSON.stringify(snap2.d),
    'cambio orario ha modificato geometrie/versioni territoriali');
  console.log('MUTAZIONE ORARIO:', {
    richiesta: requestIds[1], nuovoOrario: movedB.toISOString(),
    direttriciInvariate: true,
    opportunitaCandidate: movedSnap.o.filter(o => o.stato === 'candidata').length,
    opportunitaSuperate: movedSnap.o.filter(o => o.stato === 'superata').length,
    visibiliPopbus: activeMoved.length
  });

  // Ripristina la domanda originale e verifica la riconciliazione.
  await client.query(`UPDATE public.richieste_pop_bus SET start_datetime=$1 WHERE id=$2`,
    [originalB, requestIds[1]]);
  const engineRestored = await rebuildFromSql();
  await publishAll(engineRestored);
  const finalSnap = await snapshot();
  await verificaAssociazioni(engineRestored, 'orario_ripristinato');
  const finalRead = await leggiOpportunitaPixel({limit:1000,client});
  assert(finalSnap.d.length === snap2.d.length, 'catalogo cambiato dopo ripristino');
  assert(JSON.stringify(finalSnap.d) === JSON.stringify(snap2.d),
    'geometrie mutate dopo ripristino');
  assert(finalRead.some(o => o.nodi.map(Number).join('>') === '8>5>7' &&
    requestIds.every(id => o.richiesta_ids.map(Number).includes(id))),
    'opportunita composta originale non recuperata');
  for (const o of finalSnap.o) {
    if (o.stato === 'superata') assert(!finalRead.some(r => String(r.pixel_opportunita_id) === String(o.id)),
      'POPBUS legge opportunita superata');
  }
  console.log('TEST ASSOCIAZIONI OK:', {
    richieste: requestIds.length, direttrici: finalSnap.d.length,
    mutazioneTemporale: true, storicizzazione: true,
    ripristinoCompatibilita: true, visibiliPopbus: finalRead.length
  });
} catch (e) {
  failed = true;
  console.error('TEST DINAMICO FALLITO:', e.stack || e.message);
} finally {
  if (client) {
    if (inTx) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK ESEGUITO: nessuna scrittura confermata.'); }
      catch (e) { failed = true; console.error('ROLLBACK FALLITO:', e.message); }
    }
    client.release();
  }
  await pool.end();
}
if (failed) process.exitCode = 1;
