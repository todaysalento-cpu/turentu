// TURENTU PIXEL — mutazioni domanda: annullamento e posti (ROLLBACK).
// Solo test manuale: BEGIN + ROLLBACK SEMPRE; non tocca worker, pagamenti o missioni.
// PREREQUISITO: pixel.persistence.service.js deve supportare `client` esterno
// sia in pubblicaOpportunitaPixel sia in leggiOpportunitaPixel.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/db.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';
import { leg } from '../services/popbus/v2/planner.js';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';
import { generaFormazioniAlternative, valutaRichieste } from '../services/popbus/v2/model.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { leggiContestiOpportunitaPixel, generaFormazioniDaOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';


if (!process.env.TURENTU_MATRIX_HOUR) {
  // Quattro processi isolati: ogni scenario crea fixture proprie e fa ROLLBACK.
  const results=[];
  const file=fileURLToPath(import.meta.url);
  let failed=false;
  for (const hour of [14]) {
    console.log(`\n=== SCENARIO ${String(hour).padStart(2,'0')}:00 EUROPE/ROME — 01/11/2026 ===`);
    const run=spawnSync(process.execPath, ['--env-file=.env',file], {
      cwd:process.cwd(),
      env:{...process.env,TURENTU_MATRIX_HOUR:String(hour)},
      encoding:'utf8', maxBuffer:32*1024*1024, timeout:600000
    });
    const stdout=run.stdout||'';
    const marker=stdout.split(/\r?\n/).find(line=>line.startsWith('MATRICE_RISULTATO_JSON:'));
    const rollback=stdout.includes('ROLLBACK ESEGUITO: nessuna scrittura confermata.');
    const prova=stdout.split(/\r?\n/).find(line=>line.startsWith('ASSEGNAZIONE_MULTI_JSON:'));
    const globale=stdout.split(/\r?\n/).find(line=>line.startsWith('OTTIMIZZAZIONE_GLOBALE_JSON:'));
    const sensibilita=stdout.split(/\r?\n/).find(line=>line.startsWith('SENSIBILITA_ECONOMICA_JSON:'));
    const audit=stdout.split(/\r?\n/).find(line=>line.startsWith('AUDIT_ECONOMICO_MISSIONI_JSON:'));
    if(prova) {
      const evidence=JSON.parse(prova.slice('ASSEGNAZIONE_MULTI_JSON:'.length));
      console.log('ASSEGNAZIONE MULTI-VEICOLO DIAGNOSTICA OK:', evidence);
    }

    if(run.status!==0 || !marker || !rollback || !prova || !globale || !sensibilita || !audit){
      failed=true;
      console.error('SCENARIO FALLITO:',hour,'exit:',run.status,'rollback:',rollback,'provaAssegnazione:',Boolean(prova),'ottimizzazione:',Boolean(globale));
      console.error(stdout.slice(-18000));
      console.error((run.stderr||'').slice(-6000));
      break;
    }
    const network=JSON.parse(globale.slice('OTTIMIZZAZIONE_GLOBALE_JSON:'.length));
    console.log('OTTIMIZZAZIONE MULTI-MISSIONE DIAGNOSTICA:',JSON.stringify(network,null,2));
    console.log('SENSIBILITA ECONOMICA 12 RICHIESTE:',JSON.stringify(JSON.parse(sensibilita.slice('SENSIBILITA_ECONOMICA_JSON:'.length)),null,2));
    console.log('AUDIT ECONOMICO PER MISSIONE:',JSON.stringify(JSON.parse(audit.slice('AUDIT_ECONOMICO_MISSIONI_JSON:'.length)),null,2));
    const result=JSON.parse(marker.slice('MATRICE_RISULTATO_JSON:'.length));
    results.push(result);
    console.log('RIEPILOGO:', {
      formazioni:result.formazioni,
      coppie:result.coppieFormazioneVeicolo,
      compatibili:result.compatibiliTurno,
      scartiTurno:result.scartiTurno,
      motivi:result.motiviScarto,
      veicoliCompatibili:result.idsCompatibili,
      multiVeicoloOsservato:result.simultaneitaVeicoliDistintiStessoOperatoreOsservata,
      attivabiliPrezziFixture:result.attivabiliPrezziFixture,
      rollback
    });
    console.table(result.graduatorie);
  }
  if(!failed && results.length===1){
    console.log('\nRIEPILOGO SCENARIO MULTI-VEICOLO:');
    console.table(results.map(r=>({
      oraRoma:`${r.oraLocale}:00`,
      veicoliDistinti:r.idsCompatibili.length,
      coppieCompatibili:r.compatibiliTurno,
      scartiTurno:r.scartiTurno,
      economicheFixture:r.attivabiliPrezziFixture,
      multiVeicolo:r.simultaneitaVeicoliDistintiStessoOperatoreOsservata
    })));
    console.log('ROLLBACK SCENARIO MULTI-VEICOLO CONFERMATO. Nessuna attivazione.');
  } else process.exitCode=1;
} else {
const assert = (v, m) => { if (!v) throw new Error(`PIXEL DOMANDA DINAMICA ROLLBACK: ${m}`); };
const NODES = [8, 5, 7];
const localHour = Number(process.env.TURENTU_MATRIX_HOUR);
assert([10,12,14,16].includes(localHour), 'ora matrice non valida');
// 1 novembre 2026: CET (UTC+1). Stessa data e domanda, cambia solo l'ora.
const date = new Date(Date.UTC(2026, 10, 1, localHour - 1, 0, 0, 0));
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
  // 12 richieste: quattro ondate temporali da tre O/D ciascuna.
  // I nodi territoriali sono quelli REALI disponibili nella fixture (8,5,7).
  // Non si inventano nodi o direttrici POPBUS; PIXEL li costruisce.
  const coreCases=cases.slice();
  const waveMinutes=[45,90,135];
  for (const minutes of waveMinutes) {
    const shift=minutes*60000;
    cases.push(
      {a:8,b:5,at:new Date(date.getTime()+shift),prezzo:7},
      {a:5,b:7,at:new Date(date.getTime()+shift+Math.round(first.seconds)*1000),prezzo:9},
      {a:8,b:7,at:new Date(date.getTime()+shift),prezzo:14}
    );
  }
  assert(cases.length===12,'fixture non contiene 12 richieste');
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
  const coreIds=requestIds.slice(0,3);
  assert(requestIds.length===12&&new Set(requestIds).size===12,'richieste sintetiche duplicate');
  console.log('RICHIESTE NON CONFERMATE (12, quattro ondate):', requestIds);
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
  assert(composed && coreIds.every(id => composed.richiestaIds.includes(id)), 'direttrice composta non valida');
  const published1 = await publishAll(engine1);
  const snap1 = await snapshot();
  await verificaAssociazioni(engine1, 'baseline');
  assert(snap1.d.some(d => d.engine_id === 'territorial:8>5>7'), 'direttrice SQL non pubblicata');
  const read1 = await leggiOpportunitaPixel({ limit: 1000, client });
  assert(read1.some(o => o.nodi.map(Number).join('>') === '8>5>7' &&
    coreIds.every(id => o.richiesta_ids.map(Number).includes(id))), 'POPBUS non legge opportunita composta');
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

  // Test 1: variazione posti. PIXEL attualmente raggruppa richieste per
  // geometria/orario: controlliamo anche se la nuova quantita arriva a POPBUS.
  const seatId = requestIds[2];
  await client.query(`UPDATE public.richieste_pop_bus SET posti_richiesti=3 WHERE id=$1`, [seatId]);
  const seatDb = (await client.query(`SELECT posti_richiesti FROM public.richieste_pop_bus WHERE id=$1`, [seatId])).rows[0];
  assert(Number(seatDb.posti_richiesti) === 3, 'aggiornamento posti non riuscito');

  async function rebuildFromSql() {
    const rows = (await client.query(`SELECT engine_id, versione, nodi, legs
      FROM public.pixel_direttrici WHERE stato='attiva'
      ORDER BY engine_id, versione DESC`)).rows;
    const restored = rows.map((d, i) => {
      assert(d.engine_id === `territorial:${d.nodi.join('>')}`, 'engine_id incoerente');
      return { id: `px-${i + 1}`, nodes: d.nodi.map(Number), legs: d.legs,
        richiestaIds: [], versione: Number(d.versione) };
    });
    // Il filtro di stato e intenzionale: verifica il percorso di ingestione
    // delle richieste attive. NON dimostra che il worker reale applichi il filtro.
    const current = (await client.query(`SELECT * FROM public.richieste_pop_bus
      WHERE id=ANY($1::integer[]) AND stato='in_attesa' ORDER BY id`, [requestIds])).rows;
    const e = createIncrementalCorridorEngine({ routeNodes: road,
      initialCorridors: restored, abilitaVariantiP1: true });
    for (const r of current) await e.processRequest(r);
    return e;
  }

  const seatsEngine = await rebuildFromSql();
  await publishAll(seatsEngine);
  await verificaAssociazioni(seatsEngine, 'posti_1_a_3');
  const seatsRead = await leggiOpportunitaPixel({limit:1000,client});
  assert(seatsRead.some(o => o.richiesta_ids.map(Number).includes(seatId)),
    'la richiesta con posti aggiornati non e piu visibile');
  const seatFields = seatsRead.filter(o => o.richiesta_ids.map(Number).includes(seatId))
    .map(o => ({ opportunitaId: String(o.pixel_opportunita_id), datiTemporali: o.dati_temporali }));
  console.log('VARIAZIONE POSTI OK (DB e associazioni):', {
    richiesta: seatId, postiPrecedenti: 1, postiAttuali: 3,
    opportunitaAssociate: seatFields.length,
    nota: 'Il reader POPBUS espone ID richieste e dati_temporali, non garantisce posti_richiesti. Verificare la successiva lettura della richiesta.'
  });

  // TEST INTEGRAZIONE CAPACITA: associazione PIXEL -> lettura SQL -> generatore POPBUS V2.
  // Il reader PIXEL fornisce ID, non posti. Recuperiamo SEMPRE la riga corrente
  // usando lo stesso client transazionale: la modifica non e' ancora committata.
  const associated = seatsRead.filter(o => o.richiesta_ids.map(Number).includes(seatId));
  assert(associated.length > 0, 'nessuna opportunita PIXEL associata alla richiesta aggiornata');
  const currentSeat = (await client.query(`
    SELECT id, origine_nodo_territoriale_id, destinazione_nodo_territoriale_id,
           start_datetime, posti_richiesti, prezzo, classe, stato
    FROM public.richieste_pop_bus WHERE id=$1 AND stato='in_attesa'`, [seatId])).rows[0];
  assert(currentSeat && Number(currentSeat.posti_richiesti) === 3,
    'POPBUS non recupera 3 posti dalla richiesta corrente associata a PIXEL');
  const opportunity = associated.find(o => {
    const ids = o.nodi.map(Number);
    return ids.indexOf(Number(currentSeat.origine_nodo_territoriale_id)) >= 0 &&
      ids.indexOf(Number(currentSeat.destinazione_nodo_territoriale_id)) >
      ids.indexOf(Number(currentSeat.origine_nodo_territoriale_id));
  });
  assert(opportunity, 'nessuna opportunita PIXEL compatibile con origine/destinazione');
  // Scenario mirato: una richiesta gia' associata da PIXEL, senza generare
  // nuove direttrici territoriali. Prezzo alto SOLO nella copia in memoria
  // per non confondere il vincolo di capacita' con la soglia economica.
  const inputRequest = {
    ...currentSeat,
    start_node_id: Number(currentSeat.origine_nodo_territoriale_id),
    end_node_id: Number(currentSeat.destinazione_nodo_territoriale_id),
    posti_richiesti: Number(currentSeat.posti_richiesti),
    prezzo: 10000
  };
  const startNode = nodeMap.get(inputRequest.start_node_id);
  const endNode = nodeMap.get(inputRequest.end_node_id);
  assert(startNode && endNode, 'nodi del test di capacita non disponibili');
  const capacityNodes = [startNode, endNode].map(n => ({id:Number(n.id),lat:n.lat,lon:n.lon}));
  const capacityRoad = async (a,b) => {
    const result = await leg(a,b);
    assert(result && Number(result.metres)>0 && Number(result.seconds)>0,
      'routing POPBUS non valido');
    return result;
  };
  async function verificaCapienza(postiVeicolo) {
    const vehicle = {id:900001,lat:startNode.lat,lon:startNode.lon,
      posti_totali:postiVeicolo,euro_km:0.5};
    const result = await generaCandidatiFlotta({
      requests:[inputRequest], nodes:capacityNodes, vehicles:[vehicle],
      road:capacityRoad
    }, {strict:false});
    assert(result && Array.isArray(result.candidati), 'risultato POPBUS non valido');
    assert(result.diagnostica?.routingSenzaErrori === true,
      `routing POPBUS fallito: ${JSON.stringify(result.diagnostica?.routingErrori)}`);
    assert(result.diagnostica?.enumerazioneSenzaTagli === true,
      'enumerazione POPBUS troncata');
    return result.candidati.filter(c =>
      c.veicolo === vehicle.id && c.richieste.some(ids => ids.includes(seatId)));
  }
  const insufficient = await verificaCapienza(2);
  const sufficient = await verificaCapienza(4);
  assert(insufficient.length === 0, 'POPBUS ha ammesso 3 posti su veicolo da 2');
  assert(sufficient.length > 0, 'POPBUS non ha prodotto candidato per 3 posti su veicolo da 4');
  assert(sufficient.every(c => c.dettaglio_missioni.some(m =>
    m.richieste.includes(seatId) && Number(m.posti) === 3)),
    'il candidato POPBUS non riporta i 3 posti aggiornati');
  console.log('INTEGRAZIONE DATI PIXEL -> POPBUS CAPACITA OK:', {
    richiesta:seatId, postiLettiDalDb:3, opportunitaPixel:String(opportunity.pixel_opportunita_id),
    candidatiVeicolo2:insufficient.length, candidatiVeicolo4:sufficient.length,
    nota:'Test di integrazione dati; NON certifica che il worker operativo consumi PIXEL.'
  });

  // TEST ADAPTER PIXEL -> POPBUS: nessun worker, nessuna attivazione.
  // La lista di richieste di ciascuna opportunita e un limite rigido.
  // Un seed per volta: il model considera ogni seed obbligatorio.
  function adattaOpportunita(opportunita, dbRequests) {
    const ids = (opportunita.richiesta_ids || []).map(Number);
    const nodes = (opportunita.nodi || []).map(Number);
    const legs = opportunita.legs;
    const start = new Date(opportunita.inizio_finestra).getTime();
    const end = new Date(opportunita.fine_finestra).getTime();
    assert(ids.length && new Set(ids).size === ids.length, 'opportunita con ID duplicati/vuoti');
    assert(nodes.length >= 2 && new Set(nodes).size === nodes.length, 'nodi PIXEL non validi');
    assert(Array.isArray(legs) && legs.length === nodes.length - 1, 'legs PIXEL incoerenti');
    assert(Number.isFinite(start) && Number.isFinite(end) && start <= end,
      'finestra PIXEL non valida');
    const allowed = new Set(ids);
    const selected = dbRequests.filter(r => allowed.has(Number(r.id)) && r.stato === 'in_attesa');
    assert(selected.length === allowed.size, 'opportunita PIXEL contiene richieste assenti/non valide');
    return {
      id: String(opportunita.pixel_opportunita_id), nodes, legs,
      window: {start, end}, requests: selected, allowed
    };
  }
  const candidateRead = await leggiOpportunitaPixel({limit:1000,client});
  const currentRequests = (await client.query(
    `SELECT * FROM public.richieste_pop_bus WHERE id=ANY($1::integer[])`, [requestIds])).rows.map(r => ({
      ...r,
      start_node_id: Number(r.origine_nodo_territoriale_id),
      end_node_id: Number(r.destinazione_nodo_territoriale_id)
    }));
  assert(currentRequests.every(r => Number.isSafeInteger(r.start_node_id) && r.start_node_id > 0 &&
    Number.isSafeInteger(r.end_node_id) && r.end_node_id > 0),
    'normalizzazione nodi POPBUS non valida');
  const syntheticIds = new Set(requestIds);
  const ownOpportunities = candidateRead.filter(o =>
    o.richiesta_ids.some(id => syntheticIds.has(Number(id))));
  assert(ownOpportunities.length > 0, 'nessuna opportunita PIXEL del fixture');
  const represented=new Set(ownOpportunities.flatMap(o=>o.richiesta_ids.map(Number)));
  assert(requestIds.every(id=>represented.has(id)),
    'non tutte le 12 richieste sono presenti nelle opportunita PIXEL');
  console.log('DOMANDA 12 RICHIESTE PIXEL OK:',{
    richieste:requestIds.length,
    opportunita:ownOpportunities.length,
    associazioni:ownOpportunities.reduce((n,o)=>n+o.richiesta_ids.length,0),
    ondateLocali:['14:00','14:45','15:30','16:15'],
    richiesteRappresentate:represented.size
  });
  let formations = 0;
  let outsideWindow = 0;
  let examinedSeeds = 0;
  let zeroVariantSeeds = 0;
  const seenFormation = new Set();
  for (const o of ownOpportunities) {
    const a = adattaOpportunita(o, currentRequests);
    const plan = {nodes:a.nodes,legs:a.legs};
    for (const seed of a.allowed) {
      examinedSeeds++;
      const variants = generaFormazioniAlternative(plan,a.requests,[seed],{maxFormazioni:80});
      if (variants.length === 0) {
        zeroVariantSeeds++;
        console.log('SEED SENZA FORMAZIONI:', {
          opportunita: a.id, seed, nodes: a.nodes,
          richieste: a.requests.map(r => ({id: r.id, start: r.start_node_id,
            end: r.end_node_id, data: r.start_datetime, posti: r.posti_richiesti}))
        });
      }
      for (const evaluation of variants) {
        const ids = evaluation.requests.map(r => Number(r.id));
        assert(ids.length > 0 && ids.includes(seed), 'seed obbligatorio non rispettato');
        assert(ids.every(id => a.allowed.has(id)), 'FORMAZIONE CON RICHIESTA FUORI OPPORTUNITA');
        assert(evaluation.peak > 0, 'picco posti non valido');
        assert(evaluation.departure <= evaluation.arrival, 'tempi valutazione invalidi');
        // L'intersezione con la finestra PIXEL e un requisito ulteriore:
        // NON considerare attivabili valutazioni fuori dalla finestra.
        if (evaluation.departure < a.window.start || evaluation.departure > a.window.end) {
          outsideWindow++;
          continue;
        }
        const k = `${a.id}|${ids.slice().sort((x,y)=>x-y).join(',')}|${evaluation.departure}`;
        if (seenFormation.has(k)) continue;
        seenFormation.add(k);
        formations++;
        // Controllo posti del model con un tetto esplicito; senza un veicolo
        // maxPeak=Infinity e la capienza non e ancora certificata.
        const cap = valutaRichieste(plan,a.requests,[seed],
          {mode:'seeds_only',includeIds:ids.filter(id=>id!==seed),maxPeak:evaluation.peak});
        assert(cap && cap.peak === evaluation.peak, 'occupazione per segmenti incoerente');
        if (evaluation.peak > 1) {
          const tooSmall = valutaRichieste(plan,a.requests,[seed],
            {mode:'seeds_only',includeIds:ids.filter(id=>id!==seed),maxPeak:evaluation.peak-1});
          assert(tooSmall === null, 'capienza insufficiente non rifiutata');
        }
      }
    }
  }
  assert(formations > 0,
    `nessuna formazione entro finestra PIXEL (fuori finestra: ${outsideWindow}, seed senza formazioni: ${zeroVariantSeeds}/${examinedSeeds})`);
  console.log('ADAPTER PIXEL -> POPBUS E2E ISOLATO OK:', {
    opportunitaFixture:ownOpportunities.length, seedsEsaminati:examinedSeeds,
    formazioniUnicheNellaFinestra:formations, scartateFuoriFinestra:outsideWindow,
    vincoloAppartenenza:true, compatibilitaTemporaleModel:true,
    capacitaSegmenti:true, nessunaAttivazione:true,
    limite:'Adapter sperimentale nel test; worker operativo NON collegato a PIXEL.'
  });

  // TEST DEL MODULO REALE: stesso client e stessa transazione con ROLLBACK.
  // Questo controllo NON sostituisce la verifica della selezione operativa dei veicoli.
  const contestiReali = await leggiContestiOpportunitaPixel({client, limit:1000});
  const contestiFixture = contestiReali.filter(c =>
    c.richiesta_ids.some(id => syntheticIds.has(Number(id))));
  assert(contestiFixture.length === ownOpportunities.length,
    `adapter reale: opportunita fixture ${contestiFixture.length} invece di ${ownOpportunities.length}`);
  const byOpportunity = new Map(ownOpportunities.map(o =>
    [Number(o.pixel_opportunita_id), o]));
  let totalFormations = 0;
  let totalSeeds = 0;
  const uniqueReal = new Set();
  for (const c of contestiFixture) {
    const source = byOpportunity.get(Number(c.pixel_opportunita_id));
    assert(source, `opportunita ${c.pixel_opportunita_id} non attesa`);
    assert(c.richiesta_ids.length === source.richiesta_ids.length &&
      c.richiesta_ids.every(id => source.richiesta_ids.map(Number).includes(id)),
      `opportunita ${c.pixel_opportunita_id}: associazioni mutate`);
    assert(c.requests.every(r => Number.isSafeInteger(r.start_node_id) &&
      Number.isSafeInteger(r.end_node_id) && r.stato === 'in_attesa' && r.corsa_id == null),
      `opportunita ${c.pixel_opportunita_id}: normalizzazione/stato non valido`);
    totalSeeds += c.richiesta_ids.length;
    const candidates = generaFormazioniDaOpportunitaPixel(c,{maxFormazioniPerSeed:80});
    for (const candidate of candidates) {
      const ids = candidate.evaluation.requests.map(r => Number(r.id));
      assert(ids.length && ids.every(id => c.richiesta_ids.includes(id)),
        'adapter reale: richiesta estranea alla opportunita');
      assert(candidate.evaluation.departure >= c.window.start &&
        candidate.evaluation.departure <= c.window.end,
        'adapter reale: partenza fuori finestra PIXEL');
      assert(candidate.evaluation.peak > 0 &&
        candidate.evaluation.arrival >= candidate.evaluation.departure,
        'adapter reale: formazione incoerente');
      const key = `${c.pixel_opportunita_id}|${ids.slice().sort((a,b)=>a-b).join(',')}|${candidate.evaluation.departure}`;
      assert(!uniqueReal.has(key), 'adapter reale: formazione duplicata');
      uniqueReal.add(key);
      totalFormations++;
    }
  }
  assert(totalFormations > 0, 'adapter reale: nessuna formazione fixture');
  console.log('ADAPTER REALE PIXEL -> POPBUS E2E ROLLBACK OK:', {
    opportunitaFixture:contestiFixture.length, seeds:totalSeeds,
    formazioni:totalFormations, duplicati:0, fuoriFinestra:0,
    richiesteEstranee:0, scrittureConfermate:0,
    limite:'Worker operativo non collegato; contesti esterni alla fixture non certificati.'
  });

  // TEST ECONOMICO OPERATIVO ISOLATO: formazioni REALI PIXEL,
  // veicolo SIMULATO (non censito DB), routing reale, costi reali del modello.
  // Non certifica turni, conflitti, pagamenti o assegnazione del worker.
  const vehicleTest = {
    id: 'fixture_veicolo_4_posti',
    posti_totali: 4,
    euro_km: 0.50,
    ...nodeMap.get(8)
  };
  const roadBetween = async (a, b) => {
    if (Math.abs(Number(a.lat)-Number(b.lat)) < 1e-7 &&
        Math.abs(Number(a.lon)-Number(b.lon)) < 1e-7) {
      return {metres:0,seconds:0};
    }
    const r = await leg(a,b);
    assert(r && Number.isFinite(Number(r.metres)) && Number(r.metres)>=0 &&
      Number.isFinite(Number(r.seconds)) && Number(r.seconds)>=0,
      'routing reale non disponibile');
    return r;
  };
  const economiaStats = {
    formazioniEsaminate:0, capienzaCompatibile:0,
    capienzaInsufficiente2Posti:0, cicliValutati:0,
    economicheConPrezziFixture:0, economicheConRicavoSimulato:0,
    avvicinamentoKm:0, ritornoBaseKm:0
  };
  for (const c of contestiFixture) {
    const variants = generaFormazioniDaOpportunitaPixel(c,{maxFormazioniPerSeed:80});
    const startNode = nodeMap.get(Number(c.plan.nodes[0]));
    const endNode = nodeMap.get(Number(c.plan.nodes.at(-1)));
    assert(startNode && endNode, 'nodi della missione assenti');
    const approach = await roadBetween(vehicleTest,startNode);
    const returnTrip = await roadBetween(endNode,vehicleTest);
    const kmMissioni = c.plan.legs.reduce((s,l)=>s+Number(l.metres),0)/1000;
    for (const f of variants) {
      economiaStats.formazioniEsaminate++;
      if (f.evaluation.peak > 2) economiaStats.capienzaInsufficiente2Posti++;
      if (f.evaluation.peak > vehicleTest.posti_totali) continue;
      economiaStats.capienzaCompatibile++;
      const busyStart = f.evaluation.departure - Number(approach.seconds)*1000;
      const busyEnd = f.evaluation.arrival + Number(returnTrip.seconds)*1000;
      assert(Number.isFinite(busyStart) && Number.isFinite(busyEnd) && busyEnd > busyStart,
        'intervallo operativo completo invalido');
      const ids = new Set(f.evaluation.requests.map(r=>Number(r.id)));
      const chosenRequests = c.requests.filter(r=>ids.has(Number(r.id)));
      assert(chosenRequests.length === ids.size,'richieste mancanti per pricing');
      const args = {
        ricaviRichiesteEuro:chosenRequests.map(r=>Number(r.prezzo)),
        kmAvvicinamento:Number(approach.metres)/1000,
        kmMissioni,
        kmTrasferimenti:0,
        kmRitornoBase:Number(returnTrip.metres)/1000,
        euroKm:vehicleTest.euro_km
      };
      const actual = valutaEconomiaCiclo(args);
      assert(Number.isFinite(actual.costoCompletoEuro) && actual.costoCompletoEuro>=0,
        'costo completo non valido');
      assert(Number.isFinite(actual.sogliaAttivazioneLordaEuro) &&
        actual.sogliaAttivazioneLordaEuro>=actual.costoCompletoEuro,
        'soglia economica non valida');
      const simulated = valutaEconomiaCiclo({
        ...args, ricaviRichiesteEuro:chosenRequests.map(()=>10000)
      });
      assert(simulated.economicamenteAttivabile,
        'scenario ricavi elevati dovrebbe coprire costo e commissione');
      economiaStats.cicliValutati++;
      if (actual.economicamenteAttivabile) economiaStats.economicheConPrezziFixture++;
      if (simulated.economicamenteAttivabile) economiaStats.economicheConRicavoSimulato++;
      economiaStats.avvicinamentoKm = Math.max(economiaStats.avvicinamentoKm,args.kmAvvicinamento);
      economiaStats.ritornoBaseKm = Math.max(economiaStats.ritornoBaseKm,args.kmRitornoBase);
    }
  }
  assert(economiaStats.formazioniEsaminate>0 && economiaStats.cicliValutati>0,
    'nessuna formazione economica valutata');
  assert(economiaStats.economicheConRicavoSimulato===economiaStats.cicliValutati,
    'scenario ricavi simulati incoerente');
  console.log('PIXEL -> POPBUS ECONOMIA CICLO ISOLATA OK:', {
    ...economiaStats,
    veicolo:'SIMULATO 4 posti a 0.50 euro/km, base nodo 8',
    costoInclude:'avvicinamento + missione + ritorno base',
    nota:'Prezzi fixture e simulati distinti; non certifica turni, conflitti, pagamenti o worker.'
  });

  // ================================================================
  // FLOTTA REALE — lettura SQL identica ai filtri principali del worker.
  // SOLO DIAGNOSI: NON richiama turno()/conflittiVeicolo() del worker
  // (non esportate), NON esegue il selettore operativo/attivazioni.
  // ================================================================
  const flotta = (await client.query(`
    SELECT v.id, v.driver_id, v.modello, v.posti_totali, v.stato,
           t.euro_km, dv.start, dv.fine, dv.manual,
           dv.giorni_esclusi, dv.inattivita,
           ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
           ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
    FROM veicolo v
    JOIN disponibilita_veicolo dv ON dv.veicolo_id=v.id
    JOIN LATERAL (
      SELECT MIN(euro_km) AS euro_km FROM tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0
    ) t ON t.euro_km IS NOT NULL
    WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
      AND COALESCE(dv.coord,v.coord) IS NOT NULL
    ORDER BY t.euro_km,v.id
  `)).rows;
  assert(flotta.length>0,'nessun veicolo reale caricato dal database');
  assert(flotta.every(v=>Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lon))),
    'coordinate flotta non valide');

  // Replica diagnostica della semantica ricorrente mostrata dal worker.
  // L'originale resta la fonte di verita per l'eventuale attivazione.
  const fmtMin = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/Rome', hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  });
  const fmtDay = new Intl.DateTimeFormat('en-US', {
    timeZone:'Europe/Rome',weekday:'short'
  });
  const days=['sun','mon','tue','wed','thu','fri','sat'];
  const dayNames=['domenica','lunedi','martedi','mercoledi','giovedi','venerdi','sabato'];
  const minRome=t=>{
    const parts=fmtMin.formatToParts(new Date(t));
    return Number(parts.find(x=>x.type==='hour').value)*60+
      Number(parts.find(x=>x.type==='minute').value);
  };
  const dayRome=t=>days.indexOf(fmtDay.format(new Date(t)).toLowerCase());
  const excluded=(v,t)=>{
    if (!Array.isArray(v.giorni_esclusi)) return false;
    const d=dayRome(t);
    return v.giorni_esclusi.some(x=>{
      const val=String(x).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      return val===String(d)||(d===0&&val==='7')||val===days[d]||val===dayNames[d];
    });
  };
  const inactive=(v,a,b)=>{
    if (!Array.isArray(v.inattivita)) return true;
    return v.inattivita.some(p=>{
      if (!p||typeof p!=='object') return true;
      const x=new Date(p.start??p.inizio??p.dal??p.da).getTime();
      const y=new Date(p.fine??p.end??p.al??p.a).getTime();
      return !Number.isFinite(x)||!Number.isFinite(y)||x<b&&y>a;
    });
  };
  const turnoDiagnostico=(v,a,b)=>{
    if (!Number.isFinite(a)||!Number.isFinite(b)||b<=a||!v.start||!v.fine) return false;
    const s=minRome(v.start),e=minRome(v.fine);
    if (!Number.isFinite(s)||!Number.isFinite(e)||s===e||inactive(v,a,b)) return false;
    for(let t=a;t<b;t=Math.min(b,Math.floor(t/60000)*60000+60000)){
      const m=minRome(t);
      if (!(s<e?(m>=s&&m<e):(m>=s||m<e))) return false;
      const turnoDay=s>e&&m<e?t-86400000:t;
      if(excluded(v,turnoDay)) return false;
    }
    return true;
  };
  const routeCache=new Map();
  const cachedRoad=async(a,b)=>{
    const key=[Number(a.lat).toFixed(6),Number(a.lon).toFixed(6),
      Number(b.lat).toFixed(6),Number(b.lon).toFixed(6)].join('|');
    if(!routeCache.has(key)) routeCache.set(key,await roadBetween(a,b));
    return routeCache.get(key);
  };
  const statsFlotta={
    veicoliCaricati:flotta.length,operatori:new Set(flotta.map(v=>v.driver_id)).size,
    opportunita:contestiFixture.length,formazioni:0,coppieFormazioneVeicolo:0,
    scartiCapienza:0,scartiAvvicinamento:0,scartiTurno:0,
    compatibiliTurno:0,attivabiliPrezziFixture:0,attivabiliRicaviSimulati:0,
    routingDistinti:0
  };
  // Diagnostica dei 112 scarti: individua il PRIMO minuto non compatibile.
  const fmtRome = new Intl.DateTimeFormat('it-IT', {
    timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  });
  const iso=t=>new Date(t).toISOString();
  const hhmm=t=>String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
  const motivazioneTurno=(v,a,b)=>{
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||!v.start||!v.fine)
      return {motivo:'intervallo_invalido'};
    const s=minRome(v.start),e=minRome(v.fine);
    if(!Number.isFinite(s)||!Number.isFinite(e)||s===e)
      return {motivo:'fascia_invalida'};
    if(inactive(v,a,b)) return {motivo:'inattivita'};
    for(let t=a;t<b;t=Math.min(b,Math.floor(t/60000)*60000+60000)){
      const m=minRome(t);
      if(!(s<e?(m>=s&&m<e):(m>=s||m<e)))
        return {motivo:'fuori_fascia',primoMinutoNonValido:iso(t),
          primoMinutoRoma:fmtRome.format(new Date(t)),
          minutoLocale:hhmm(m),fascia:hhmm(s)+'-'+hhmm(e)};
      const turnoDay=s>e&&m<e?t-86400000:t;
      if(excluded(v,turnoDay))
        return {motivo:'giorno_escluso',primoMinutoNonValido:iso(t),
          primoMinutoRoma:fmtRome.format(new Date(t))};
    }
    return {motivo:'compatibile'};
  };
  const dettagliScarti=new Map();
  const conteggioMotivi={};
  const graduatorie=[];
  const candidatiTotali=[];
  for(const c of contestiFixture){
    const startNode=nodeMap.get(Number(c.plan.nodes[0]));
    const endNode=nodeMap.get(Number(c.plan.nodes.at(-1)));
    assert(startNode&&endNode,'nodi formazione mancanti');
    const kmMissione=c.plan.legs.reduce((a,l)=>a+Number(l.metres),0)/1000;
    for(const f of generaFormazioniDaOpportunitaPixel(c,{maxFormazioniPerSeed:80})){
      statsFlotta.formazioni++;
      const chosen=new Set(f.evaluation.requests.map(r=>Number(r.id)));
      const prices=c.requests.filter(r=>chosen.has(Number(r.id))).map(r=>Number(r.prezzo));
      assert(prices.length===chosen.size,'prezzi richieste non disponibili');
      const risultati=[];
      for(const v of flotta){
        statsFlotta.coppieFormazioneVeicolo++;
        if(Number(v.posti_totali)<Number(f.evaluation.peak)){
          statsFlotta.scartiCapienza++;continue;
        }
        const a=await cachedRoad(v,startNode);
        const r=await cachedRoad(endNode,v);
        const busyStart=Number(f.evaluation.departure)-Number(a.seconds)*1000;
        const busyEnd=Number(f.evaluation.arrival)+Number(r.seconds)*1000;
        if(!Number.isFinite(busyStart)||!Number.isFinite(busyEnd)||busyEnd<=busyStart){
          statsFlotta.scartiAvvicinamento++;continue;
        }
        if(!turnoDiagnostico(v,busyStart,busyEnd)){
          statsFlotta.scartiTurno++;
          const why=motivazioneTurno(v,busyStart,busyEnd);
          conteggioMotivi[why.motivo]=(conteggioMotivi[why.motivo]||0)+1;
          const id=Number(v.id);
          if(!dettagliScarti.has(id)) dettagliScarti.set(id,{
            veicolo:id,modello:v.modello,posti:Number(v.posti_totali),
            turnoRegistratoUTC:iso(v.start)+' / '+iso(v.fine),
            fasciaRicorrenteRoma:hhmm(minRome(v.start))+'-'+hhmm(minRome(v.fine)),
            inizioCicloUTC:iso(busyStart),inizioCicloRoma:fmtRome.format(new Date(busyStart)),
            partenzaMissioneUTC:iso(f.evaluation.departure),
            partenzaMissioneRoma:fmtRome.format(new Date(f.evaluation.departure)),
            fineMissioneUTC:iso(f.evaluation.arrival),
            fineCicloUTC:iso(busyEnd),fineCicloRoma:fmtRome.format(new Date(busyEnd)),
            kmAvvicinamento:Number((Number(a.metres)/1000).toFixed(2)),
            minutiAvvicinamento:Number((Number(a.seconds)/60).toFixed(1)),
            kmRitorno:Number((Number(r.metres)/1000).toFixed(2)),
            minutiRitorno:Number((Number(r.seconds)/60).toFixed(1)),
            motivo:why.motivo,primoMinutoNonValido:why.primoMinutoNonValido,
            primoMinutoRoma:why.primoMinutoRoma,
            fascia:why.fascia
          });
          continue;
        }
        statsFlotta.compatibiliTurno++;
        const args={ricaviRichiesteEuro:prices,kmAvvicinamento:Number(a.metres)/1000,
          kmMissioni:kmMissione,kmTrasferimenti:0,kmRitornoBase:Number(r.metres)/1000,
          euroKm:Number(v.euro_km)};
        const real=valutaEconomiaCiclo(args);
        const simulated=valutaEconomiaCiclo({
          ...args,ricaviRichiesteEuro:prices.map(()=>10000)
        });
        if(real.economicamenteAttivabile) statsFlotta.attivabiliPrezziFixture++;
        if(simulated.economicamenteAttivabile) statsFlotta.attivabiliRicaviSimulati++;
        const result={
          veicolo:Number(v.id),operatore:Number(v.driver_id),modello:v.modello,
          posti:Number(v.posti_totali),euroKm:Number(v.euro_km),
          kmAvvicinamento:Number(args.kmAvvicinamento.toFixed(2)),
          kmRitorno:Number(args.kmRitornoBase.toFixed(2)),
          kmMissione:Number(args.kmMissioni),kmTrasferimenti:Number(args.kmTrasferimenti),
          ricaviBase:prices.reduce((sum,p)=>sum+Number(p),0),
          costoCiclo:Number(real.costoCompletoEuro.toFixed(2)),
          sogliaLorda:Number(real.sogliaAttivazioneLordaEuro.toFixed(2)),
          attivabile:real.economicamenteAttivabile,
          attivabileSimulato:simulated.economicamenteAttivabile,
          busyStart,busyEnd,
          opportunita:String(c.pixel_opportunita_id),
          richieste:[...chosen].sort((a,b)=>a-b)
        };
        risultati.push(result);
        candidatiTotali.push(result);
      }
      risultati.sort((a,b)=>a.costoCiclo-b.costoCiclo||a.veicolo-b.veicolo);
      graduatorie.push({
        opportunita:String(c.pixel_opportunita_id),
        richieste:[...chosen].sort((a,b)=>a-b),
        postiPicco:Number(f.evaluation.peak),
        partenza:new Date(f.evaluation.departure).toISOString(),
        candidatiTurno:risultati.length,
        migliori:risultati.slice(0,3).map(({busyStart,busyEnd,...rest})=>rest)
      });
    }
  }
  statsFlotta.routingDistinti=routeCache.size;
  assert(statsFlotta.formazioni===totalFormations,'numero formazioni mutato');
  assert(statsFlotta.coppieFormazioneVeicolo===statsFlotta.formazioni*flotta.length,
    'coppie formazione-veicolo non complete');
  assert(statsFlotta.scartiCapienza+statsFlotta.scartiAvvicinamento+
    statsFlotta.scartiTurno+statsFlotta.compatibiliTurno===statsFlotta.coppieFormazioneVeicolo,
    'contabilita filtri flotta incoerente');
  console.log('PIXEL -> POPBUS FLOTTA REALE DIAGNOSTICA OK:',statsFlotta);
  console.log('GRADUATORIE PER FORMAZIONE:',JSON.stringify(graduatorie,null,2));
  console.log('MOTIVI SCARTO TURNO:',conteggioMotivi);
  console.log('DIAGNOSI TURNO PER VEICOLO (PRIMO SCARTO):',
    JSON.stringify([...dettagliScarti.values()].sort((a,b)=>a.veicolo-b.veicolo),null,2));
  console.log('NOTA ORA LEGALE: fascia ricorrente interpretata in Europe/Rome; '+
    'i timestamp UTC di ottobre possono rappresentare orari locali diversi da quelli attesi.');

  // Test di esclusivita: stesso veicolo non puo coprire intervalli
  // sovrapposti; veicoli distinti dello stesso operatore non si bloccano.
  // E' un controllo dell'invariante, NON una prova del selettore worker.
  const overlaps=(a,b)=>a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd;
  const collideSame=candidatiTotali.some((a,i)=>candidatiTotali.some((b,j)=>
    j>i&&a.veicolo===b.veicolo&&a.opportunita!==b.opportunita&&overlaps(a,b)));
  const coexistDifferent=candidatiTotali.some((a,i)=>candidatiTotali.some((b,j)=>
    j>i&&a.veicolo!==b.veicolo&&a.operatore===b.operatore&&
    a.opportunita!==b.opportunita&&overlaps(a,b)));
  const canAssign=(existing,next)=>existing.every(x=>x.veicolo!==next.veicolo||!overlaps(x,next));
  if(collideSame){
    const pair=candidatiTotali.flatMap((a,i)=>candidatiTotali.slice(i+1)
      .filter(b=>a.veicolo===b.veicolo&&a.opportunita!==b.opportunita&&overlaps(a,b))
      .map(b=>[a,b]))[0];
    assert(!canAssign([pair[0]],pair[1]),'doppia assegnazione stesso veicolo non bloccata');
  }
  if(coexistDifferent){
    const pair=candidatiTotali.flatMap((a,i)=>candidatiTotali.slice(i+1)
      .filter(b=>a.veicolo!==b.veicolo&&a.operatore===b.operatore&&
        a.opportunita!==b.opportunita&&overlaps(a,b)).map(b=>[a,b]))[0];
    assert(canAssign([pair[0]],pair[1]),'due veicoli distinti stesso operatore bloccati');
  }
  console.log('ESCLUSIVITA MULTI-VEICOLO (REGOLA ISOLATA):',{
    conflittoStessoVeicoloOsservato:collideSame,
    simultaneitaVeicoliDistintiStessoOperatoreOsservata:coexistDifferent,
    nota:'Non certifica conflitti DB, disponibilita conducente fisico o selettore del worker.'
  });
  // Assegnazione simulata di due missioni PIXEL distinte e sovrapposte.
  // Nessuna INSERT in corse/missioni: verifica del selettore DIAGNOSTICO,
  // non del selettore operativo non esportato dal worker.
  const opportunitaDistinte=[...new Set(candidatiTotali.map(c=>c.opportunita))];
  assert(opportunitaDistinte.length>=2,'servono due opportunita PIXEL distinte');
  const formationsFor=o=>{
    const groups=new Map();
    for(const c of candidatiTotali.filter(x=>x.opportunita===o)){
      const key=c.richieste.join(',');
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(c);
    }
    return [...groups.values()].sort((a,b)=>b[0].richieste.length-a[0].richieste.length);
  };
  const pairOpp=opportunitaDistinte.flatMap((a,i)=>opportunitaDistinte.slice(i+1).map(b=>[a,b]))
    .find(([a,b])=>formationsFor(a).some(g=>g.some(x=>
      formationsFor(b).some(h=>h.some(y=>overlaps(x,y)&&
        x.richieste.every(id=>!y.richieste.includes(id))&&x.operatore===y.operatore&&x.veicolo!==y.veicolo)))));
  assert(pairOpp,'nessuna coppia di opportunita con missioni sovrapposte e richieste disgiunte');
  const missionA=formationsFor(pairOpp[0]).find(g=>g.some(x=>
    formationsFor(pairOpp[1]).some(h=>h.some(y=>overlaps(x,y)&&
      x.richieste.every(id=>!y.richieste.includes(id))&&x.operatore===y.operatore&&x.veicolo!==y.veicolo))));
  assert(missionA?.length>1,'insufficienti candidati per missione A');
  const sortCost=arr=>[...arr].sort((a,b)=>a.costoCiclo-b.costoCiclo||a.veicolo-b.veicolo);
  const prima=sortCost(missionA).find(x=>formationsFor(pairOpp[1]).some(g=>
    g[0].richieste.every(id=>!x.richieste.includes(id)) &&
    g.some(y=>canAssign([x],y)&&overlaps(x,y)&&x.operatore===y.operatore)));
  assert(prima,'nessun veicolo A consente missione B disgiunta');
  // PIXEL consente associazioni multiple. POPBUS deve scegliere una formazione B
  // che NON contenga richieste gia' impiegate dalla missione A.
  const richiesteImpegnate=new Set(prima.richieste.map(Number));
  const formazioniB=formationsFor(pairOpp[1]);
  const opzioniB=formazioniB
    .filter(gruppo=>gruppo.length>1 && gruppo[0].richieste.every(id=>!richiesteImpegnate.has(Number(id))))
    .map(gruppo=>({gruppo,graduatoria:sortCost(gruppo)}))
    .map(o=>({...o,scelta:o.graduatoria.find(c=>canAssign([prima],c)&&overlaps(prima,c)&&c.operatore===prima.operatore)}))
    .filter(o=>o.scelta)
    .sort((a,b)=>b.scelta.richieste.length-a.scelta.richieste.length||
      a.scelta.costoCiclo-b.scelta.costoCiclo);
  assert(opzioniB.length>0,'nessuna formazione B disgiunta e sovrapposta disponibile');
  const {graduatoria:graduatoriaB,scelta:seconda}=opzioniB[0];
  assert(prima.opportunita!==seconda.opportunita,'missioni non distinte');
  assert(overlaps(prima,seconda),'le missioni non si sovrappongono');
  assert(prima.operatore===seconda.operatore,'operatori non coincidono');
  assert(prima.veicolo!==seconda.veicolo,'doppia assegnazione stesso veicolo');
  assert(canAssign([prima],seconda),'selettore diagnostico ha bloccato veicoli distinti');
  const conflittoB=graduatoriaB.find(c=>c.veicolo===prima.veicolo&&overlaps(prima,c));
  assert(conflittoB,'manca candidato conflittuale per la seconda missione');
  assert(!canAssign([prima],conflittoB),'doppia assegnazione non respinta');
  const terza={...seconda,opportunita:'TERZA_MISSIONE_SIMULATA'};
  assert(!canAssign([prima,seconda],terza),'terza missione sullo stesso veicolo non respinta');
  const alternativeB=graduatoriaB.filter(c=>canAssign([prima],c));
  assert(alternativeB[0].veicolo===seconda.veicolo,'graduatoria B non ricalcolata');
  const incrocioRichieste=prima.richieste.filter(id=>richiesteImpegnate.has(Number(id))&&
    seconda.richieste.map(Number).includes(Number(id)));
  assert(incrocioRichieste.length===0,'richiesta passeggero duplicata tra missioni');
  const economicsFixtureOK=prima.attivabile&&seconda.attivabile;
  // Prezzi fixture possono cambiare con la domanda; registriamo il risultato, non lo forziamo.
  assert(prima.attivabileSimulato&&seconda.attivabileSimulato,
    'ricavi simulati non sufficienti: impossibile isolare il vincolo di flotta');
  const provaAssegnazione={
    orarioRoma:'14:00',operatore:prima.operatore,
    missioneA:{opportunita:prima.opportunita,richieste:prima.richieste,
      veicolo:prima.veicolo,costoCiclo:prima.costoCiclo},
    missioneB:{opportunita:seconda.opportunita,richieste:seconda.richieste,
      veicolo:seconda.veicolo,costoCiclo:seconda.costoCiclo},
    candidatiBPrima:graduatoriaB.length,
    candidatiBDopoEsclusione:alternativeB.length,
    stessoVeicoloRespinto:true,terzaMissioneStessoVeicoloRespinta:true,
    veicoliDistintiStessoOperatore:true,
    richiesteNonDuplicate:true,formazioniBDisgiunte:opzioniB.length,
    entrambeEconomichePrezziFixture:economicsFixtureOK,
    entrambeEconomicheRicaviSimulati:true,
    assegnazioniPersistite:0,
    limite:'Simulazione isolata: NON certifica il selettore operativo o conflitti DB.'
  };
  console.log('ASSEGNAZIONE_MULTI_JSON:'+JSON.stringify(provaAssegnazione));

  // OTTIMIZZAZIONE DIAGNOSTICA DI RETE: beam search deterministica.
  // Non e' un ottimo matematico certificato; non modifica il worker.
  const requestIndex=new Map(requestIds.map((id,i)=>[Number(id),i]));
  assert(requestIndex.size===12,'l ottimizzatore richiede 12 richieste uniche');
  const bitFor=ids=>ids.reduce((mask,id)=>{
    const pos=requestIndex.get(Number(id));
    assert(pos!==undefined,'formazione contiene richiesta estranea alla fixture');
    return mask|(1<<pos);
  },0);
  const countBits=n=>{let k=0;while(n){n&=n-1;k++;}return k;};
  const sortPlan=(a,b)=>countBits(b.mask)-countBits(a.mask)||
    a.missions.length-b.missions.length||a.cost-b.cost||
    a.signature.localeCompare(b.signature);
  const optimizeNetwork=({economics,beamWidth=300,maxVehiclesPerFormation=4,moltiplicatore=1})=>{
    const grouped=new Map();
    for(const c of candidatiTotali){
      if(economics==='fixture'&&!c.attivabile)continue;
      if(economics==='moltiplicata' && c.ricaviBase*moltiplicatore+1e-8<c.sogliaLorda)continue;
      if(economics==='simulata'&&!c.attivabileSimulato)continue;
      const key=c.opportunita+'|'+c.richieste.join(',');
      if(!grouped.has(key))grouped.set(key,[]);
      grouped.get(key).push(c);
    }
    const options=[];
    for(const candidates of grouped.values()){
      const sorted=sortCost(candidates);
      const used=new Set();
      for(const c of sorted){
        if(used.has(c.veicolo))continue;
        used.add(c.veicolo);
        options.push({...c,mask:bitFor(c.richieste)});
        if(used.size>=maxVehiclesPerFormation)break;
      }
    }
    // Priorita' al servizio della domanda, poi al numero di missioni, poi al costo.
    options.sort((a,b)=>countBits(b.mask)-countBits(a.mask)||
      a.costoCiclo-b.costoCiclo||a.opportunita.localeCompare(b.opportunita)||a.veicolo-b.veicolo);
    let beam=[{mask:0,missions:[],cost:0,signature:''}];
    let examined=0;
    let bestEver=beam[0];
    const maxMissions=12;
    for(let depth=1;depth<=maxMissions;depth++){
      const next=[];
      for(const state of beam){
        for(const c of options){
          examined++;
          if((state.mask&c.mask)!==0)continue;
          if(state.missions.some(m=>m.opportunita===c.opportunita))continue;
          if(!canAssign(state.missions,c))continue;
          const missions=[...state.missions,c];
          next.push({mask:state.mask|c.mask,missions,
            cost:state.cost+c.costoCiclo,
            signature:missions.map(m=>m.opportunita+':'+m.veicolo+':'+m.richieste.join('-')).sort().join('|')});
        }
      }
      if(!next.length)break;
      next.sort(sortPlan);
      const seen=new Set();
      const distinct=[];
      for(const st of next){
        // Conservo diversi assetti temporali e di veicoli per lo stesso mask.
        const key=st.mask+'|'+st.missions.map(m=>m.opportunita+':'+m.veicolo).sort().join(',');
        if(seen.has(key))continue;
        seen.add(key);distinct.push(st);
        if(distinct.length>=beamWidth)break;
      }
      beam=distinct;
      if(sortPlan(beam[0],bestEver)<0)bestEver=beam[0];
      if(beam.some(st=>st.mask===(1<<12)-1))break;
    }
    const best=bestEver;
    const usedIds=new Set(best.missions.flatMap(m=>m.richieste.map(Number)));
    assert(usedIds.size===countBits(best.mask),'ottimizzatore: passeggeri duplicati');
    assert(best.missions.every((m,i)=>canAssign(best.missions.filter((_,j)=>i!==j),m)),
      'ottimizzatore: conflitto di veicolo');
    assert(new Set(best.missions.map(m=>m.opportunita)).size===best.missions.length,
      'ottimizzatore: opportunita PIXEL duplicata');
    return {
      metodo:'beam_search_diagnostica_non_ottimo_certificato',
      economia:economics,moltiplicatore:moltiplicatore,larghezzaBeam:beamWidth,
      formazioniVeicoloEsaminate:options.length,espansioniValutate:examined,
      richiesteTotali:requestIds.length,richiesteServite:usedIds.size,
      richiesteNonServite:requestIds.filter(id=>!usedIds.has(Number(id))),
      missioni:best.missions.length,costoTotaleEuro:Number(best.cost.toFixed(2)),
      assegnazioni:best.missions.map(m=>({opportunita:m.opportunita,
        richieste:m.richieste,veicolo:m.veicolo,operatore:m.operatore,
        costoCiclo:m.costoCiclo,inizioCiclo:new Date(m.busyStart).toISOString(),
        fineCiclo:new Date(m.busyEnd).toISOString()}))
    };
  };
  const reteFixture=optimizeNetwork({economics:'fixture'});
  const reteSimulata=optimizeNetwork({economics:'simulata'});
  const reteOperativa=optimizeNetwork({economics:'nessuna'});
  assert(reteFixture.richiesteServite<=reteOperativa.richiesteServite,
    'economia fixture ha aumentato copertura rispetto alla fattibilita operativa');
  assert(reteSimulata.richiesteServite<=reteOperativa.richiesteServite,
    'ricavi simulati hanno aumentato copertura oltre la fattibilita operativa');
  // Sensibilita economica: moltiplichiamo SOLO i ricavi, mai il costo del ciclo.
  // La soglia lorda deriva dalla funzione di pricing reale gia' valutata per candidato.
  // Controllo di coerenza del criterio ricavi >= soglia ai prezzi originali.
  const mismatches=candidatiTotali.filter(c=>
    (c.ricaviBase+1e-8>=c.sogliaLorda)!==c.attivabile);
  assert(mismatches.length===0,
    'La soglia lorda non riproduce valutaEconomiaCiclo alla tariffa base: fermarsi, non interpolare');
  const factors=[1,1.25,1.5,2,3,4,5,7.5,10,15,20,30,50,100];
  const scenarios=factors.map(f=>{
    const result=optimizeNetwork({economics:'moltiplicata',moltiplicatore:f});
    return {moltiplicatore:f,incrementoPercento:Math.round((f-1)*100),
      ricavoTotaleDomandaEuro:Number((cases.reduce((sum,c)=>sum+Number(c.prezzo),0)*f).toFixed(2)),
      richiesteServite:result.richiesteServite,missioni:result.missioni,
      costoCicliEuro:result.costoTotaleEuro,richiesteNonServite:result.richiesteNonServite,
      assegnazioni:result.assegnazioni};
  });
  const minRatio=Math.min(...candidatiTotali.filter(c=>c.ricaviBase>0)
    .map(c=>c.sogliaLorda/c.ricaviBase));
  const full=scenarios.find(x=>x.richiesteServite===12);
  // Ricerca monotona della prima soglia di copertura completa trovata dalla beam search.
  // Non certifica un ottimo globale ne' un punto matematicamente esatto.
  let threshold=null;
  if(full){
    let lo=1,hi=full.moltiplicatore;
    for(let i=0;i<14;i++){
      const mid=(lo+hi)/2;
      const r=optimizeNetwork({economics:'moltiplicata',moltiplicatore:mid});
      if(r.richiesteServite===12)hi=mid;else lo=mid;
    }
    threshold={moltiplicatoreStimato:Number(hi.toFixed(5)),
      incrementoPercentoStimato:Number(((hi-1)*100).toFixed(2)),
      precisioneIntervallo:hi-lo,
      metodo:'bisezione euristica su copertura beam search, non ottimo certificato'};
  }
  // AUDIT ECONOMICO: il pricing viene RICALCOLATO con la funzione reale
  // per ogni missione e fattore. Non ci si limita a interpolare una soglia arrotondata.
  // La commissione 15% e' riportata separatamente a scopo illustrativo:
  // NON va sottratta una seconda volta se il pricing la incorpora gia'.
  const prezzoPerId=new Map(requestIds.map((id,i)=>[Number(id),Number(cases[i].prezzo)]));
  const round2=n=>Number(n.toFixed(2));
  const prezzoPerMissione=(c,f)=>c.richieste.map(id=>{
    assert(prezzoPerId.has(Number(id)),'richiesta senza prezzo nella fixture');
    return prezzoPerId.get(Number(id))*f;
  });
  const calcolaAudit=(c,f)=>{
    const ricavi=prezzoPerMissione(c,f);
    const risultato=valutaEconomiaCiclo({
      ricaviRichiesteEuro:ricavi,
      kmAvvicinamento:c.kmAvvicinamento,
      kmMissioni:c.kmMissione,
      kmTrasferimenti:c.kmTrasferimenti,
      kmRitornoBase:c.kmRitorno,
      euroKm:c.euroKm
    });
    const ricavo=ricavi.reduce((s,n)=>s+n,0);
    const atteso=ricavo+1e-8>=risultato.sogliaAttivazioneLordaEuro;
    // Diagnostica non bloccante: la funzione reale puo' adottare arrotondamenti
    // o condizioni aggiuntive. Non sostituire il suo verdetto con una soglia inferita.
    const divergenzaAttivazione=atteso!==risultato.economicamenteAttivabile;
    if(divergenzaAttivazione) console.warn('AUDIT_DIVERGENZA_SOGLIA_JSON:'+JSON.stringify({
      opportunita:c.opportunita,veicolo:c.veicolo,moltiplicatore:f,
      ricavoLordoEuro:ricavo,sogliaLordaEuro:risultato.sogliaAttivazioneLordaEuro,
      differenzaEuro:ricavo-risultato.sogliaAttivazioneLordaEuro,
      attivabilePerConfronto:atteso,attivabileSecondoPricingReale:risultato.economicamenteAttivabile
    }));
    assert(Math.abs(risultato.costoCompletoEuro-c.costoCiclo)<0.03,
      'costo ciclo variato rispetto al candidato originale');
    return {
      opportunita:c.opportunita,richieste:c.richieste,veicolo:c.veicolo,operatore:c.operatore,
      kmAvvicinamento:c.kmAvvicinamento,kmMissione:c.kmMissione,
      kmTrasferimenti:c.kmTrasferimenti,kmRitornoBase:c.kmRitorno,euroKm:c.euroKm,
      ricaviSingoleRichiesteEuro:ricavi.map(round2),
      ricavoLordoEuro:round2(ricavo),
      costoCicloEuro:round2(risultato.costoCompletoEuro),
      sogliaLordaEuro:round2(risultato.sogliaAttivazioneLordaEuro),
      differenzaRicavoSogliaEuro:round2(ricavo-risultato.sogliaAttivazioneLordaEuro),
      commissione15PercentoIllustrativaEuro:round2(ricavo*0.15),
      ricavoDopoCommissioneIllustrativoEuro:round2(ricavo*0.85),
      differenzaDopoCommissioneMenoCostoEuro:round2(ricavo*0.85-risultato.costoCompletoEuro),
      attivabileSecondoPricingReale:risultato.economicamenteAttivabile,
      attivabilePerConfrontoSoglia:atteso,
      divergenzaAttivazione
    };
  };
  const fullPlan=reteOperativa.assegnazioni.map(m=>{
    const c=candidatiTotali.find(x=>x.opportunita===m.opportunita &&
      x.veicolo===m.veicolo && x.richieste.join(',')===m.richieste.join(','));
    assert(c,'candidato non trovato per piano operativo');
    return c;
  });
  assert(fullPlan.length===2,'audit richiede le due missioni del piano completo');
  const near=threshold?.moltiplicatoreStimato;
  const multipliers=[1,1.25,...(near?[near-0.0001,near,near+0.0001]:[]),1.5];
  const auditScenari=multipliers.map(f=>{
    const missioni=fullPlan.map(c=>calcolaAudit(c,f));
    const ricavoTotale=missioni.reduce((s,m)=>s+m.ricavoLordoEuro,0);
    return {moltiplicatore:Number(f.toFixed(5)),
      ricavoTotaleEuro:round2(ricavoTotale),
      costoTotaleEuro:round2(missioni.reduce((s,m)=>s+m.costoCicloEuro,0)),
      commissioneIllustrativaEuro:round2(ricavoTotale*0.15),
      tutteLeMissioniAttivabili:missioni.every(m=>m.attivabileSecondoPricingReale),
      missioni};
  });
  // La soglia di rete e' riferita alla selezione euristica: non e' necessariamente
  // la soglia delle DUE missioni del piano operativo senza vincolo economico.
  const audit={metodo:'ricalcolo_valutaEconomiaCiclo_per_missione',
    piano:'piano_completo_senza_vincolo_economico',
    sogliaCoperturaEuristica:threshold,
    aliquotaCommissioneIllustrativa:0.15,
    nota:'Commissione 15% informativa: verificare nel modulo pricing se gia inclusa. La differenza netta illustrativa NON e una seconda soglia di attivazione.',
    scenari:auditScenari};
  console.log('AUDIT_ECONOMICO_MISSIONI_JSON:'+JSON.stringify(audit));
  console.log('SENSIBILITA_ECONOMICA_JSON:'+JSON.stringify({
    ricavoDomandaBaseEuro:cases.reduce((sum,c)=>sum+Number(c.prezzo),0), costoCicloPianoOperativoEuro:reteOperativa.costoTotaleEuro,
    moltiplicatoreMinimoSingolaCoppia:Number(minRatio.toFixed(5)),
    sogliaCoperturaCompleta:threshold,scenari:scenarios,
    nota:'Soglia lorda gia calcolata con ritorno; moltiplicazione dei soli ricavi. Nessuna modifica worker o database.'
  }));
  console.log('OTTIMIZZAZIONE_GLOBALE_JSON:'+JSON.stringify({
    domanda:requestIds,soloFattibilita:reteOperativa,
    economiaFixture:reteFixture,ricaviSimulati:reteSimulata,
    limite:'Beam search euristica; nessuna scrittura missioni, nessuna garanzia di ottimo globale.'
  }));

  // Riepilogo machine-readable per il processo padre; non conferma assegnazioni.
  const idsCompatibili = [...new Set(candidatiTotali.map(x=>x.veicolo))].sort((a,b)=>a-b);
  const topByFormation = graduatorie.map(g=>({
    opportunita:g.opportunita,
    richieste:g.richieste,
    postiPicco:g.postiPicco,
    candidatiTurno:g.candidatiTurno,
    migliorVeicolo:g.migliori[0]?.veicolo ?? null,
    costoMigliore:g.migliori[0]?.costoCiclo ?? null
  }));
  console.log('MATRICE_RISULTATO_JSON:'+JSON.stringify({
    oraLocale:localHour,
    dataMissione:date.toISOString(),
    ...statsFlotta,
    motiviScarto:conteggioMotivi,
    idsCompatibili,
    conflittoStessoVeicoloOsservato:collideSame,
    simultaneitaVeicoliDistintiStessoOperatoreOsservata:coexistDifferent,
    graduatorie:topByFormation
  }));

  // Test 2: annullamento della richiesta B. Si verifica l'assenza dagli
  // output candidati e si preserva il catalogo territoriale.
  const cancelledId = requestIds[1];
  await client.query(`UPDATE public.richieste_pop_bus SET stato='annullata' WHERE id=$1`, [cancelledId]);
  const cancelledDb = (await client.query(`SELECT stato FROM public.richieste_pop_bus WHERE id=$1`, [cancelledId])).rows[0];
  assert(cancelledDb.stato === 'annullata', 'stato annullata non salvato');
  const cancelledEngine = await rebuildFromSql();
  await publishAll(cancelledEngine);
  await verificaAssociazioni(cancelledEngine, 'richiesta_annullata');
  const cancelledRead = await leggiOpportunitaPixel({limit:1000,client});
  assert(cancelledRead.every(o => !o.richiesta_ids.map(Number).includes(cancelledId)),
    `richiesta annullata ${cancelledId} ancora candidata POPBUS`);
  const afterCancel = await snapshot();
  assert(JSON.stringify(afterCancel.d) === JSON.stringify(snap2.d),
    'annullamento ha modificato il catalogo territoriale');
  console.log('ANNULLAMENTO OK:', {
    richiesta: cancelledId, esclusaDaPopbus: true,
    direttriciInvariate: true, opportunitaCandidate: cancelledRead.length,
    opportunitaSuperate: afterCancel.o.filter(o => o.stato === 'superata').length
  });

  // Test 3: riattivazione e ripristino posti; nessun dato sintetico persiste.
  await client.query(`UPDATE public.richieste_pop_bus SET stato='in_attesa' WHERE id=$1`, [cancelledId]);
  await client.query(`UPDATE public.richieste_pop_bus SET posti_richiesti=1 WHERE id=$1`, [seatId]);
  const restoredEngine = await rebuildFromSql();
  await publishAll(restoredEngine);
  await verificaAssociazioni(restoredEngine, 'ripristino_domanda');
  const restoredRead = await leggiOpportunitaPixel({limit:1000,client});
  assert(restoredRead.some(o => o.nodi.map(Number).join('>') === '8>5>7' &&
    coreIds.every(id => o.richiesta_ids.map(Number).includes(id))),
    'gruppo composto originale non recuperato');
  const finalSnap = await snapshot();
  assert(JSON.stringify(finalSnap.d) === JSON.stringify(snap2.d),
    'catalogo territoriale cambiato dopo ripristino');
  console.log('TEST MUTAZIONI DOMANDA E CAPACITA OK:', {
    richieste: requestIds.length, direttrici: finalSnap.d.length,
    variazionePostiDb: true, associazioniPosti: true, integrazioneDatiCapacita: true,
    annullamento: true, ripristino: true,
    visibiliPopbus: restoredRead.length,
    limite: 'Non certificato il consumo operativo delle opportunita PIXEL da parte del worker POPBUS V2.'
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

}
