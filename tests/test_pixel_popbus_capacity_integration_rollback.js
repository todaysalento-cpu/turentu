// TURENTU — PIXEL -> POPBUS V2: test integrazione dati e capienza (READ ONLY).
// Salvare in tests/test_pixel_popbus_capacity_integration_rollback.js
// Eseguire: node --env-file=.env tests\test_pixel_popbus_capacity_integration_rollback.js
// NON certifica il collegamento operativo del worker; NON modifica richieste reali.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';

let client;
let inTx = false;
try {
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  inTx = true;
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '3s'");

  const opportunities = await leggiOpportunitaPixel({ limit: 1000, client });
  assert(opportunities.length, 'Nessuna opportunita PIXEL visibile: pubblicare prima un fixture isolato');
  const ids = [...new Set(opportunities.flatMap(o => (o.richiesta_ids || []).map(Number)))];
  assert(ids.length, 'Opportunita senza richieste associate');
  const { rows } = await client.query(`
    SELECT id, origine_nodo_territoriale_id, destinazione_nodo_territoriale_id,
           start_datetime, posti_richiesti, prezzo, classe, stato, corsa_id
    FROM public.richieste_pop_bus WHERE id = ANY($1::integer[])
  `, [ids]);
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const o = opportunities.find(o => (o.richiesta_ids || []).some(id => {
    const r = byId.get(Number(id));
    return r && r.stato === 'in_attesa' && r.corsa_id == null &&
      new Date(r.start_datetime).getTime() > Date.now() + 86400000;
  }));
  assert(o, 'Nessuna richiesta PIXEL in attesa e futura disponibile; test non eseguito');
  const source = o.richiesta_ids.map(Number).map(id => byId.get(id)).find(r =>
    r && r.stato === 'in_attesa' && r.corsa_id == null &&
    new Date(r.start_datetime).getTime() > Date.now() + 86400000);
  assert(source, 'Richiesta sorgente non disponibile');
  const reqId = Number(source.id);
  assert(o.richiesta_ids.map(Number).includes(reqId), 'Associazione PIXEL mancante');
  console.log('ASSOCIAZIONE PIXEL LETTA:', {
    opportunita: o.pixel_opportunita_id, direttrice: o.pixel_direttrice_id,
    richiesta: reqId, postiDB: Number(source.posti_richiesti)
  });

  // Si prova una mutazione logica 1 -> 3 SOLO IN MEMORIA, non una UPDATE SQL.
  // La lettura DB dimostra il join per ID; il matching verifica la capienza.
  const startId = Number(source.origine_nodo_territoriale_id);
  const endId = Number(source.destinazione_nodo_territoriale_id);
  assert(startId > 0 && endId > 0 && startId !== endId, 'Nodi territoriali non validi');
  const n = await client.query(`
    SELECT id, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali WHERE id = ANY($1::bigint[])
  `, [[startId, endId]]);
  assert(n.rows.length === 2, 'Nodi territoriali assenti');
  const nodes = n.rows.map(x => ({ id: Number(x.id), lat: Number(x.lat), lon: Number(x.lon) }));
  assert(nodes.every(x => Number.isFinite(x.lat) && Number.isFinite(x.lon)), 'Coordinate non valide');
  const base = { lat: nodes[0].lat, lon: nodes[0].lon };
  const road = async (a, b) => a.lat === b.lat && a.lon === b.lon
    ? { metres: 0, seconds: 0, roadCoincident: true }
    : { metres: 2000, seconds: 300 }; // routing sintetico, NON verifica il percorso stradale
  const mkReq = seats => ({
    id: reqId, start_node_id: startId, end_node_id: endId,
    start_datetime: source.start_datetime, posti_richiesti: seats,
    prezzo: 1000, classe: source.classe || 'STANDARD'
  });
  const run = async (seats, capacity) => {
    const out = await generaCandidatiFlotta({
      requests: [mkReq(seats)], nodes,
      vehicles: [{ id: 900001, ...base, posti_totali: capacity, euro_km: 0.5 }], road
    }, { strict: false });
    assert.deepEqual(out.diagnostica.routingErrori, [], 'Errori routing');
    assert.deepEqual(out.diagnostica.limiti, [], 'Enumerazione troncata');
    assert.equal(out.utilizzabiliPerAttivazione, false, 'Non deve essere attivabile');
    return out.candidati.filter(c => c.richieste.flat().includes(reqId));
  };
  const one = await run(1, 2);
  const denied = await run(3, 2);
  const allowed = await run(3, 4);
  assert(one.some(c => c.dettaglio_missioni[0].posti === 1), 'Baseline 1 posto assente');
  assert.equal(denied.length, 0, 'ERRORE: 3 posti ammessi su veicolo da 2');
  assert(allowed.some(c => c.dettaglio_missioni[0].posti === 3), '3 posti su veicolo da 4 assenti');
  console.log('CAPACITA OK:', { unoSuDue: one.length, treSuDue: denied.length, treSuQuattro: allowed.length });
  console.log('TEST INTEGRAZIONE DATI SUPERATO (lettura associazioni reali; variazione posti simulata in memoria).');
  console.log('NON CERTIFICATO: aggiornamento SQL 1->3, lettura worker operativa, geometria reale e attivazione.');
} catch (e) {
  console.error('TEST FALLITO / NON ESEGUIBILE:', e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (inTx) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK ESEGUITO (transazione sola lettura).'); }
      catch (e) { console.error('ROLLBACK ERROR:', e.message); process.exitCode = 1; }
    }
    client.release();
  }
  await pool.end();
}
