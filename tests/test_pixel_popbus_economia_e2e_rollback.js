// TURENTU PIXEL — mutazioni domanda: annullamento e posti (ROLLBACK).
// Solo test manuale: BEGIN + ROLLBACK SEMPRE; non tocca worker, pagamenti o missioni.
// PREREQUISITO: pixel.persistence.service.js deve supportare `client` esterno
// sia in pubblicaOpportunitaPixel sia in leggiOpportunitaPixel.
import { pool } from '../db/db.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';
import { leg } from '../services/popbus/v2/planner.js';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';
import { generaFormazioniAlternative, valutaRichieste } from '../services/popbus/v2/model.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { leggiContestiOpportunitaPixel, generaFormazioniDaOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';

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
    requestIds.every(id => o.richiesta_ids.map(Number).includes(id))),
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
