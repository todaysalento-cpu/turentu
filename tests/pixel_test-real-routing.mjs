// TURENTU PIXEL — test di integrazione con routing POPBUS reale.
// Esecuzione: node tests/pixel_test-real-routing.mjs <id_Tiggiano> <id_Maglie> <id_Lecce>
// DB: sola lettura (transazione READ ONLY). Nessuna creazione corsa/prenotazione.
import assert from 'node:assert/strict';
import { createPixelNodeRouter } from '../services/pixel/node-routing.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

const ids = process.argv.slice(2).map(Number);
if (ids.length !== 3 || ids.some(n => !Number.isSafeInteger(n) || n <= 0) || new Set(ids).size !== 3) {
  console.error('Uso: node tests\\pixel_test-real-routing.mjs <ID_Tiggiano> <ID_Maglie> <ID_Lecce>');
  process.exitCode = 2;
} else {
  const [tiggiano, maglie, lecce] = ids;
  const quote = x => `"${x.replaceAll('"', '""')}"`;
  const fmt = ms => new Date(ms).toISOString();
  const mins = ms => (ms / 60000).toFixed(2);
  let passed = 0;
  const check = (label, fn) => { fn(); console.log(`OK ${++passed}: ${label}`); };

  try {
    // Importiamo la connessione gia' configurata nel progetto.
    const { pool } = await import('../db/db.js');
    const client = await pool.connect();
    const nodeMap = new Map();
    try {
      await client.query('BEGIN READ ONLY');
      const meta = await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'nodi_territoriali'`);
      const columns = new Set(meta.rows.map(x => x.column_name));
      assert.ok(columns.has('id'), 'nodi_territoriali.id assente');
      let latExpr, lonExpr;
      if (columns.has('lat') && columns.has('lon')) {
        latExpr = 'lat::double precision'; lonExpr = 'lon::double precision';
      } else {
        const geo = ['posizione', 'coord', 'geom', 'geometry', 'geometria'].find(c => columns.has(c));
        assert.ok(geo, 'Coordinate non individuate: attese lat/lon o posizione/coord/geom/geometry/geometria');
        latExpr = `ST_Y(${quote(geo)}::geometry)`;
        lonExpr = `ST_X(${quote(geo)}::geometry)`;
      }
      const nameCol = ['nome', 'name', 'localita', 'denominazione'].find(c => columns.has(c));
      const nameExpr = nameCol ? `${quote(nameCol)}::text` : 'NULL::text';
      const sql = `SELECT id, ${latExpr} AS lat, ${lonExpr} AS lon, ${nameExpr} AS nome
        FROM public.nodi_territoriali WHERE id = ANY($1::bigint[])`;
      const result = await client.query(sql, [ids]);
      for (const n of result.rows) nodeMap.set(Number(n.id), n);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
      await pool.end();
    }

    check('tre nodi territoriali letti dal DB', () => {
      assert.equal(nodeMap.size, 3, 'Uno o piu ID non sono presenti in nodi_territoriali');
      for (const id of ids) {
        const n = nodeMap.get(id);
        assert.ok(Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lon)));
      }
    });
    for (const [label, id] of [['Tiggiano', tiggiano], ['Maglie', maglie], ['Lecce', lecce]]) {
      const n = nodeMap.get(id);
      console.log(`${label}: id=${id}, DB_nome=${n.nome ?? '(non disponibile)'}, lat=${n.lat}, lon=${n.lon}`);
    }
    console.log('ATTENZIONE: verifica che gli ID corrispondano davvero alle localita indicate.');

    let legCalls = 0;
    const routeNodes = createPixelNodeRouter({
      leg: async (a, b) => { legCalls++; return leg(a, b); },
      getNode: id => nodeMap.get(id) ?? null
    });
    const outbound = await routeNodes([tiggiano, maglie, lecce]);
    check('routing reale Tiggiano > Maglie > Lecce', () => {
      assert.equal(outbound.verificataRouting, true);
      assert.equal(outbound.legs.length, 2);
      assert.ok(outbound.cumulativeSeconds[2] > outbound.cumulativeSeconds[1]);
    });
    const reverseMaglie = await routeNodes([maglie, tiggiano]);
    check('routing reale Maglie > Tiggiano', () => assert.equal(reverseMaglie.verificataRouting, true));
    const reverseLecce = await routeNodes([lecce, maglie, tiggiano]);
    check('routing reale Lecce > Maglie > Tiggiano', () => assert.equal(reverseLecce.verificataRouting, true));

    console.log('\nTEMPI STRADALI (minuti):');
    console.table([
      { tratta: 'Tiggiano > Maglie', minuti: mins(outbound.legs[0].seconds * 1000), metri: outbound.legs[0].metres },
      { tratta: 'Maglie > Lecce', minuti: mins(outbound.legs[1].seconds * 1000), metri: outbound.legs[1].metres },
      { tratta: 'Maglie > Tiggiano', minuti: mins(reverseMaglie.legs[0].seconds * 1000), metri: reverseMaglie.legs[0].metres },
      { tratta: 'Lecce > Maglie', minuti: mins(reverseLecce.legs[0].seconds * 1000), metri: reverseLecce.legs[0].metres },
      { tratta: 'Maglie > Tiggiano (da Lecce)', minuti: mins(reverseLecce.legs[1].seconds * 1000), metri: reverseLecce.legs[1].metres }
    ]);

    // Le richieste sono sintetiche e vengono inserite SOLO nel motore in memoria.
    // Scegliamo gli orari a partire dai tempi stradali reali appena ricevuti.
    const base = Date.parse('2027-04-01T09:00:00.000Z');
    const bufferMs = 10 * 60000;
    const atMaglie = base + outbound.cumulativeSeconds[1] * 1000;
    const atLecce = base + outbound.cumulativeSeconds[2] * 1000;
    const firstReturn = atMaglie + bufferMs;
    const secondReturn = atLecce + bufferMs + reverseLecce.legs[0].seconds * 1000;
    const request = (id, from, to, ms) => ({
      id, origine_nodo_territoriale_id: from, destinazione_nodo_territoriale_id: to,
      start_datetime: fmt(ms), posti_richiesti: 1
    });
    const engine = createIncrementalCorridorEngine({
      routeNodes, tolleranzaMinuti: 5,
      initialCorridors: [{ id: 'pixel-real-tiggiano-maglie-lecce',
        nodes: [tiggiano, maglie, lecce], legs: outbound.legs, richiestaIds: [] }]
    });
    await engine.processRequest(request(900001, tiggiano, lecce, base));
    await engine.processRequest(request(900002, maglie, tiggiano, firstReturn));
    await engine.processRequest(request(900003, maglie, tiggiano, secondReturn));

    const corridorId = 'pixel-real-tiggiano-maglie-lecce';
    const candidates = await engine.temporalCandidatesCompleteWithReturns(corridorId, { bufferMinuti: 10 });
    const maglieWindows = candidates.flatMap(c => c.finestreRitornoPerNodo?.[maglie] ?? []);
    check('Maglie ha opportunita con inversione a Maglie e Lecce', () => {
      assert.ok(maglieWindows.some(w => w.inversioneNodoId === maglie && w.richiestaIds.includes(900002)));
      assert.ok(maglieWindows.some(w => w.inversioneNodoId === lecce && w.richiestaIds.includes(900003)));
    });
    check('finestre con orari stradali coerenti', () => {
      const a = maglieWindows.find(w => w.inversioneNodoId === maglie && w.richiestaIds.includes(900002));
      const b = maglieWindows.find(w => w.inversioneNodoId === lecce && w.richiestaIds.includes(900003));
      const contains = (w, t) => w.finestraPassaggio.inizioMs <= t && t <= w.finestraPassaggio.fineMs;
      assert.ok(contains(a, firstReturn));
      assert.ok(contains(b, secondReturn));
      assert.ok(b.finestraPassaggio.inizioMs > a.finestraPassaggio.inizioMs);
    });
    const before = legCalls;
    const cached = await engine.temporalCandidatesCompleteWithReturns(corridorId, { bufferMinuti: 10 });
    check('seconda lettura sfrutta cache senza nuove chiamate leg', () => {
      assert.equal(legCalls, before);
      assert.equal(cached, candidates);
    });
    console.log('\nFINESTRE A MAGLIE:');
    console.table(maglieWindows.map(w => ({
      inversione: w.inversioneNodoId,
      inizio: fmt(w.finestraPassaggio.inizioMs),
      fine: fmt(w.finestraPassaggio.fineMs),
      richieste: w.richiestaIds.join(',')
    })));
    console.log(`\nPIXEL REAL ROUTING: ${passed} test superati; solo lettura DB; richieste sintetiche in memoria`);
  } catch (error) {
    console.error('\nPIXEL REAL ROUTING FALLITO:', error?.stack ?? error);
    process.exitCode = 1;
  }
}
