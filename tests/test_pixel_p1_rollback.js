// Salvare come tests/test_pixel_p1_rollback.js
// Eseguire dalla root: node --env-file=.env tests\test_pixel_p1_rollback.js
// Test transazionale: NON esegue il worker POPBUS, NON crea offerte o attivazioni.
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';

const assert = (condition, message) => { if (!condition) throw new Error(`TEST PIXEL: ${message}`); };
const testDate = new Date(Date.now() + 14 * 86400000);
testDate.setUTCHours(9, 0, 0, 0);
const atMinutes = minutes => new Date(testDate.getTime() + minutes * 60000);
const cases = [
  { a: 6, b: 7, from: 'Tiggiano, LE, Italia', to: 'Lecce, LE, Italia', minutes: 0, prezzo: 12 },
  { a: 8, b: 5, from: 'Tricase, LE, Italia', to: 'Maglie, LE, Italia', minutes: 10, prezzo: 6 },
  { a: 5, b: 7, from: 'Maglie, LE, Italia', to: 'Lecce, LE, Italia', minutes: 30, prezzo: 8 }
];

let client;
let inTransaction = false;
let failed = false;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  inTransaction = true;
  await client.query("SET LOCAL lock_timeout = '10s'");

  const { rows: nodes } = await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id = ANY($1::bigint[]) AND attivo = TRUE
  `, [[5, 6, 7, 8]]);
  assert(nodes.length === 4, 'nodi di test non tutti attivi');
  const byId = new Map(nodes.map(n => [Number(n.id), n]));

  const inserted = [];
  for (const c of cases) {
    const a = byId.get(c.a), b = byId.get(c.b);
    const { rows } = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (origine, destinazione, origine_nodo_territoriale_id,
         destinazione_nodo_territoriale_id, origine_address,
         destinazione_address, start_datetime, posti_richiesti,
         stato, classe, prezzo)
      VALUES
        (ST_SetSRID(ST_MakePoint($1,$2),4326),
         ST_SetSRID(ST_MakePoint($3,$4),4326),
         $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10)
      RETURNING *
    `, [Number(a.lon), Number(a.lat), Number(b.lon), Number(b.lat),
        c.a, c.b, c.from, c.to, atMinutes(c.minutes), c.prezzo]);
    inserted.push(rows[0]);
  }
  const ids = inserted.map(r => Number(r.id));
  console.log('Richieste sintetiche non confermate:', ids);

  const routeNodes = async nodeIds => {
    const legs = [];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const a = byId.get(Number(nodeIds[i]));
      const b = byId.get(Number(nodeIds[i + 1]));
      assert(a && b, 'nodo di routing assente');
      const result = await leg(a, b); // stesso provider stradale del worker
      assert(result && Number.isFinite(result.metres) && result.metres > 0 &&
        Number.isFinite(result.seconds) && result.seconds > 0 &&
        typeof result.polyline === 'string' && result.polyline.length > 0,
        `routing reale non valido ${nodeIds[i]} -> ${nodeIds[i + 1]}`);
      legs.push({ metres: result.metres, seconds: result.seconds,
        polyline: result.polyline, roadCoincident: false });
    }
    return { verificataRouting: true, legs };
  };

  const engine = createIncrementalCorridorEngine({
    routeNodes, tolleranzaMinuti: 30,
    abilitaVariantiP1: true, maxVariantiPerRichiesta: 12, maxNodiVariante: 8
  });
  for (const r of inserted) {
    const result = await engine.processRequest({
      ...r,
      id: Number(r.id),
      origine_nodo_territoriale_id: Number(r.origine_nodo_territoriale_id),
      destinazione_nodo_territoriale_id: Number(r.destinazione_nodo_territoriale_id)
    });
    console.log('PIXEL richiesta:', r.id, result.azione, result.direttrici, 'variantiP1:', result.variantiP1 || []);
  }

  const corridors = engine.listCorridors();
  assert(corridors.length > 0, 'nessuna direttrice generata');
  // Verifica puntuale della composizione di archi di domanda 49 (8->5) + 50 (5->7).
  const composed = corridors.find(c => c.nodes.join('>') === '8>5>7');
  assert(composed, 'P1 non ha generato la direttrice composta 8>5>7');
  const expectedIds = [ids[1], ids[2]];
  assert(expectedIds.every(id => composed.richiestaIds.includes(id)),
    'direttrice 8>5>7 non include entrambe le richieste 49 e 50 sintetiche');
  console.log('P1 COMPOSIZIONE VERIFICATA:', {
    direttrice: composed.id, nodi: composed.nodes,
    richieste: composed.richiestaIds, richiesteAttese: expectedIds
  });
  // La compatibilita spaziale NON implica una finestra temporale comune.
  console.log('P1 GRUPPI TEMPORALI:', engine.temporalCandidatesComplete(composed.id));
  let published = 0;
  for (const corridor of corridors) {
    console.log('Direttrice PIXEL:', corridor.id, corridor.nodes, corridor.richiestaIds);
    const result = await pubblicaOpportunitaPixel({
      engine, direttriceId: corridor.id, bufferMinuti: 0, client
    });
    console.log('Persistenza:', result);
    published += result.opportunitaCandidate;
  }
  assert(published > 0, 'nessuna opportunita pubblicata');

  // La lettura deve usare la STESSA connessione per vedere le righe non committate.
  const opportunities = await leggiOpportunitaPixel({ limit: 1000, client });
  const own = opportunities.filter(o => (o.richiesta_ids || []).some(id => ids.includes(Number(id))));
  assert(own.length > 0, 'nessuna opportunita leggibile nella transazione');
  for (const o of own) {
    const reqIds = o.richiesta_ids.map(Number);
    assert(reqIds.every(id => ids.includes(id)), 'opportunita contiene richieste estranee al test');
    console.log('POPBUS READ SHADOW:', {
      pixelOpportunitaId: o.pixel_opportunita_id,
      pixelDirettriceId: o.pixel_direttrice_id,
      nodi: o.nodi.map(Number), richieste: reqIds,
      finestra: [o.inizio_finestra, o.fine_finestra]
    });
  }
  const readComposed = own.filter(o => o.nodi.map(Number).join('>') === '8>5>7');
  console.log('P1 OPPORTUNITA COMPOSTE LETTE:', readComposed.length,
    '(puo essere 0 se la pubblicazione richiede un gruppo temporale compatibile)');
  console.log('TEST OK (prima del rollback):', {
    richieste: ids.length, direttrici: corridors.length,
    opportunitaPubblicate: published, opportunitaLette: own.length
  });
} catch (error) {
  failed = true;
  console.error('TEST FALLITO:', error.stack || error.message);
} finally {
  if (client) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK eseguito: nessuna scrittura del test confermata.');
      } catch (error) {
        failed = true;
        console.error('ERRORE ROLLBACK:', error.message);
      }
    }
    client.release();
  }
  await pool.end();
}
if (failed) process.exitCode = 1;
