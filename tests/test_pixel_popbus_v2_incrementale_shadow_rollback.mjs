// TURENTU — PIXEL -> POPBUS V2, domanda sintetica incrementale, SHADOW fisico.
// Esecuzione: node --env-file=.env tests\test_pixel_popbus_v2_incrementale_shadow_rollback.mjs
// UNICA transazione READ WRITE, SAVEPOINT per scenario, ROLLBACK finale obbligatorio.
// Non richiama LIVE, non crea offerte/corse, non cambia prezzi o tariffe.
import { performance } from 'node:perf_hooks';
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const assert = (ok, msg) => { if (!ok) throw new Error(`TEST INCREMENTALE: ${msg}`); };
const LEVELS = [3, 6, 9, 12];
const NODE_IDS = [8, 5, 7];
const MAX_OPPORTUNITIES = 15; // limite esplicito del servizio POPBUS V2
const fmt = x => JSON.stringify(x, null, 2);
let client, started = false, failed = false;
const summary = [];

try {
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE');
  started = true;
  await client.query("SET LOCAL lock_timeout = '5s'");
  // Il routing stradale fisico puo' richiedere tempo: nessun timeout breve.
  const { rows: nodes } = await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id=ANY($1::bigint[]) AND attivo=TRUE`, [NODE_IDS]);
  assert(nodes.length === NODE_IDS.length, 'nodi territoriali 8, 5, 7 non tutti attivi');
  const byId = new Map(nodes.map(n => [Number(n.id), {
    ...n, lat: Number(n.lat), lon: Number(n.lon)
  }]));
  const routeCache = new Map();
  const road = async ids => {
    const legs = [];
    for (let i = 1; i < ids.length; i++) {
      const a = Number(ids[i - 1]), b = Number(ids[i]);
      const key = `${a}>${b}`;
      if (!routeCache.has(key)) {
        const r = await leg(byId.get(a), byId.get(b));
        assert(r && Number(r.metres) > 0 && Number(r.seconds) > 0 &&
          typeof r.polyline === 'string' && r.polyline.length > 0,
          `routing reale mancante ${key}`);
        routeCache.set(key, { metres: r.metres, seconds: r.seconds,
          polyline: r.polyline, roadCoincident: false });
      }
      legs.push(routeCache.get(key));
    }
    return { verificataRouting: true, legs };
  };
  const first = await leg(byId.get(8), byId.get(5));
  assert(first && Number(first.seconds) > 0, 'routing 8>5 non disponibile');
  // Data futura dinamica, alle 12:00 UTC (orario locale documentato nell'output).
  const departure = new Date(Date.now() + 14 * 86400000);
  departure.setUTCHours(12, 0, 0, 0);
  const cases = [];
  for (const offsetMinutes of [0, 45, 90, 135]) {
    const t = departure.getTime() + offsetMinutes * 60000;
    cases.push(
      { a: 8, b: 5, at: new Date(t), price: 7 },
      { a: 5, b: 7, at: new Date(t + Math.round(first.seconds) * 1000), price: 9 },
      { a: 8, b: 7, at: new Date(t), price: 14 }
    );
  }
  console.log('DATA_TEST_UTC:', departure.toISOString());
  console.log('SCENARI:', LEVELS.join(', '), 'richieste; quattro ondate distinte');

  for (const count of LEVELS) {
    const scenarioStart = performance.now();
    // Ogni scenario parte dallo stesso snapshot iniziale, non accumula pubblicazioni precedenti.
    await client.query('SAVEPOINT turentu_scenario');
    try {
      const insertedIds = [];
      for (const c of cases.slice(0, count)) {
        const a = byId.get(c.a), b = byId.get(c.b);
        const { rows } = await client.query(`
          INSERT INTO public.richieste_pop_bus
          (origine, destinazione, origine_nodo_territoriale_id,
           destinazione_nodo_territoriale_id, origine_address,
           destinazione_address, start_datetime, posti_richiesti,
           stato, classe, prezzo)
          VALUES (ST_SetSRID(ST_MakePoint($1,$2),4326),
                  ST_SetSRID(ST_MakePoint($3,$4),4326),
                  $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10)
          RETURNING id`, [a.lon, a.lat, b.lon, b.lat,
          c.a, c.b, a.nome, b.nome, c.at, c.price]);
        insertedIds.push(Number(rows[0].id));
      }
      assert(insertedIds.length === count, 'inserimento sintetico incompleto');
      const { rows: requests } = await client.query(`
        SELECT * FROM public.richieste_pop_bus
        WHERE id=ANY($1::integer[]) ORDER BY id`, [insertedIds]);
      assert(requests.length === count, 'lettura richieste sintetiche incompleta');

      const pixelStart = performance.now();
      const engine = createIncrementalCorridorEngine({
        routeNodes: road, abilitaVariantiP1: true
      });
      for (const request of requests) await engine.processRequest(request);
      const corridors = engine.listCorridors();
      assert(corridors.length > 0, 'PIXEL non ha prodotto direttrici');
      for (const corridor of corridors) {
        await pubblicaOpportunitaPixel({
          engine, direttriceId: corridor.id, bufferMinuti: 0, client
        });
      }
      // Isola SOLO le opportunita che includono richieste sintetiche di questo scenario.
      const all = await leggiOpportunitaPixel({ limit: 1000, client });
      const synthetic = new Set(insertedIds);
      const own = all.filter(o =>
        o.richiesta_ids.some(id => synthetic.has(Number(id))));
      const ids = [...new Set(own.map(o => Number(o.pixel_opportunita_id)))];
      assert(ids.length > 0, 'nessuna opportunita PIXEL associata alla fixture');
      assert(ids.length <= MAX_OPPORTUNITIES,
        `${ids.length} opportunita: limite ${MAX_OPPORTUNITIES}; nessun troncamento ammesso`);
      const represented = new Set(own.flatMap(o => o.richiesta_ids.map(Number)));
      assert(insertedIds.every(id => represented.has(id)),
        'non tutte le richieste sintetiche sono associate a opportunita PIXEL');
      // Se un'opportunita contiene richieste estranee, NON attribuire i risultati alla sola fixture.
      assert(own.every(o => o.richiesta_ids.every(id => synthetic.has(Number(id)))),
        'opportunita contaminata da richieste non sintetiche: scenario non isolato');

      const pixelElapsedMs = performance.now() - pixelStart;
      const popbusStart = performance.now();
      const result = await processaPixelFirstMultimissione({
        externalClient: client,
        mode: 'ROLLBACK_ONLY',
        physicalShadow: true,
        physicalCycleShadow: true,
        physicalStrategyShadow: true,
        physicalOpportunityIds: ids,
        now: Date.now()
      });
      const popbusElapsedMs = performance.now() - popbusStart;
      const scenarioElapsedMs = performance.now() - scenarioStart;
      const performanceRecord = {
        richieste: count,
        opportunita: ids.length,
        tempoPixelEPubblicazioneMs: Math.round(pixelElapsedMs),
        tempoPopbusMs: Math.round(popbusElapsedMs),
        tempoScenarioMs: Math.round(scenarioElapsedMs),
        tempoPopbusSecondi: Number((popbusElapsedMs / 1000).toFixed(2)),
        // Metriche interne: riportate senza ipotizzare nomi o struttura.
        diagnosticaFisica: result.diagnostica ?? null,
        diagnosticaStrategie: result.confrontoStrategie?.diagnostica ?? null
      };
      console.log('POPBUS_PERFORMANCE_JSON:' + JSON.stringify(performanceRecord));
      assert(result.offerte === 0 && result.dbWrites === 0 && result.attivabile === false,
        'invarianti SHADOW violate');
      const record = {
        richiesteSintetiche: count,
        performance: {
          tempoPixelEPubblicazioneMs: Math.round(pixelElapsedMs),
          tempoPopbusMs: Math.round(popbusElapsedMs),
          tempoScenarioMs: Math.round(scenarioElapsedMs)
        },
        ondate: count / 3,
        direttriciPixel: corridors.length,
        opportunitaPixel: ids.length,
        opportunitaIds: ids,
        missioniCandidateFisiche: result.missioniCandidateFisiche,
        diagnosticaFisica: result.diagnostica,
        selezioneFisica: result.selezioneFisica,
        confrontoStrategie: result.confrontoStrategie,
        diagnosticaConflittiSnapshot: result.diagnosticaConflittiSnapshot,
        offerte: result.offerte, dbWrites: result.dbWrites,
        attivabile: result.attivabile
      };
      summary.push(record);
      console.log('SCENARIO_INCREMENTALE_JSON:' + JSON.stringify(record));
      console.log(`SCENARIO ${count}/12 OK: PIXEL ${ids.length} opportunita, SHADOW senza scritture`);
    } finally {
      // Anche in caso di errore nello scenario: ripristina i dati precedenti.
      await client.query('ROLLBACK TO SAVEPOINT turentu_scenario');
      await client.query('RELEASE SAVEPOINT turentu_scenario');
      console.log(`SAVEPOINT_RIPRISTINATO: ${count} richieste`);
    }
  }
  console.log('RIEPILOGO_INCREMENTALE_JSON:' + JSON.stringify(summary));
  console.log('TEST_INCREMENTALE_SHADOW_OK: nessuna attivazione o offerta');
} catch (error) {
  failed = true;
  console.error('TEST_INCREMENTALE_SHADOW_FAIL:', error?.stack ?? error);
} finally {
  if (client) {
    try {
      if (started) {
        await client.query('ROLLBACK');
        console.log('ROLLBACK ESEGUITO: nessuna scrittura confermata.');
      }
    } catch (error) {
      failed = true;
      console.error('ROLLBACK_FAIL:', error?.stack ?? error);
    } finally {
      client.release();
    }
  }
  await pool.end();
}
if (failed) process.exitCode = 1;
