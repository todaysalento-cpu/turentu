/**
 * TURENTU P0-C8.16A — TEST STRUTTURALE PIXEL MULTIMISSIONE, ROLLBACK OBBLIGATORIO
 * Esecuzione: node --env-file=.env tests/test_pixel_popbus_p0_c8_16a_persistenza_rollback.mjs
 * Nessun COMMIT, nessuna offerta, nessuna chiamata Stripe, nessun aggiornamento richieste.
 * NON dimostra fattibilita' economica, disponibilita' veicolo, adapter o acceptance E2E.
 */
import { pool } from '../db/db.js';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';

const fail = (message) => { throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const groupA = [196, 197, 198];
const groupD = [205, 206, 207];
const allIds = [...groupA, ...groupD];
const nodes = [8, 5, 7];
const start1 = Date.parse('2026-11-01T13:00:00Z');
const start2 = Date.parse('2026-11-01T15:15:00Z');
const secsA = 1714;
const secsB = 1901;
const secsTransfer = 2856;
const end1 = start1 + (secsA + secsB) * 1000;
const end2 = start2 + (secsA + secsB) * 1000;
const mkLeg = (metres, seconds, type) => ({ metres, seconds, testFixture: true, type });
const missionLegs = [mkLeg(24459, secsA, 'commerciale'), mkLeg(31364, secsB, 'commerciale')];
const transferLeg = mkLeg(53029, secsTransfer, 'trasferimento');
const toDate = (ms) => new Date(ms);
const sortNums = (a) => a.map(Number).sort((x, y) => x - y);
const assert = (condition, label) => {
  if (!condition) fail(label);
  console.log('PASS', label);
};

let client;
let inTx = false;
let insertedId = null;
let testError = null;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  inTx = true;
  await client.query("SET LOCAL statement_timeout = '20000ms'");
  await client.query("SET LOCAL lock_timeout = '5000ms'");
  console.log('\n=== P0-C8.16A / PIXEL MULTIMISSIONE / ROLLBACK ONLY ===');

  // Tutti i dati PIXEL sono riletti dal database, non inventati dal test.
  const { rows: opportunities } = await client.query(`
    SELECT o.id, o.stato, o.direttrice_id, d.stato AS direttrice_stato,
           d.nodi, d.engine_id, d.versione
      FROM public.pixel_opportunita o
      JOIN public.pixel_direttrici d ON d.id = o.direttrice_id
     WHERE o.id = ANY($1::bigint[])
     ORDER BY o.id
  `, [[118, 120]]);
  assert(opportunities.length === 2, 'Opportunita PIXEL 118 e 120 presenti');
  for (const o of opportunities) {
    assert(o.stato === 'candidata' && o.direttrice_stato === 'attiva', `Opportunita ${o.id} candidata e direttrice attiva`);
    assert(same(o.nodi.map(Number), nodes), `Opportunita ${o.id}: nodi 8>5>7`);
  }
  const byOpportunity = new Map(opportunities.map(o => [Number(o.id), o]));
  const { rows: associations } = await client.query(`
    SELECT opportunita_id, richiesta_id FROM public.pixel_opportunita_richieste
     WHERE opportunita_id = ANY($1::bigint[])
  `, [[118, 120]]);
  const allowed = new Map([118, 120].map(id => [id, new Set(associations.filter(a => Number(a.opportunita_id) === id).map(a => Number(a.richiesta_id)))]));
  assert(groupA.every(id => allowed.get(118).has(id)), 'Richieste 196-198 associate a PIXEL 118');
  assert(groupD.every(id => allowed.get(120).has(id)), 'Richieste 205-207 associate a PIXEL 120');
  assert(new Set(allIds).size === allIds.length, 'Nessuna richiesta duplicata');

  const { rows: requests } = await client.query(`
    SELECT id, stato, corsa_id, prezzo, posti_richiesti,
           origine_nodo_territoriale_id, destinazione_nodo_territoriale_id, start_datetime
      FROM public.richieste_pop_bus WHERE id = ANY($1::int[])
  `, [allIds]);
  assert(requests.length === allIds.length, 'Sei richieste presenti nel DB');
  assert(requests.every(r => r.stato === 'in_attesa' && r.corsa_id == null), 'Richieste in attesa e non convertite');
  const requestMap = new Map(requests.map(r => [Number(r.id), r]));
  const mapRequest = (id, offset) => {
    const r = requestMap.get(id);
    const origin = Number(r.origine_nodo_territoriale_id);
    const dest = Number(r.destinazione_nodo_territoriale_id);
    const localStart = nodes.indexOf(origin);
    const localEnd = nodes.indexOf(dest);
    if (localStart < 0 || localEnd <= localStart) fail(`Richiesta ${id}: nodi non coerenti`);
    const pickup = (offset === 0 ? start1 : start2) + (localStart === 0 ? 0 : secsA * 1000);
    if (Math.abs(new Date(r.start_datetime).getTime() - pickup) > 30 * 60 * 1000)
      fail(`Richiesta ${id}: pickup fuori tolleranza`);
    return { id, start: localStart, end: localEnd };
  };
  const localA = groupA.map(id => mapRequest(id, 0));
  const localD = groupD.map(id => mapRequest(id, 3));
  const globalRequests = [
    ...localA.map(r => ({ ...r })),
    ...localD.map(r => ({ ...r, start: r.start + 3, end: r.end + 3 }))
  ];
  const plan = {
    tipoPiano: 'CICLO_PIXEL_CORSA_UNICA_V1',
    nodes: [8, 5, 7, 8, 5, 7],
    legs: [...missionLegs, transferLeg, ...missionLegs],
    missioni: [
      { ordine: 1, startIndex: 0, endIndex: 2, partenza: start1, arrivo: end1 },
      { ordine: 2, startIndex: 3, endIndex: 5, partenza: start2, arrivo: end2 }
    ],
    evaluation: { departure: start1, arrival: end2,
      times: [0, secsA * 1000, (secsA + secsB) * 1000,
        start2 - start1, start2 - start1 + secsA * 1000,
        start2 - start1 + (secsA + secsB) * 1000],
      requests: globalRequests, peak: 3 },
    attivabile: false,
    fixtureOnly: true
  };
  assert(end1 + secsTransfer * 1000 <= start2, 'Trasferimento temporale tra missioni possibile');
  const gross = requests.reduce((sum, r) => sum + Number(r.prezzo), 0);
  assert(Math.abs(gross - 60) < 0.001, 'Ricavi richieste 60 euro (NON fattibilita economica)');

  const { rows: vehicleRows } = await client.query(`
    SELECT id, driver_id, posti_totali FROM public.veicolo WHERE id = $1
  `, [353]);
  assert(vehicleRows.length === 1 && Number(vehicleRows[0].driver_id) > 0 && Number(vehicleRows[0].posti_totali) >= 3,
    'Veicolo 353 presente e capienza sufficiente (turno NON verificato)');
  const v = vehicleRows[0];
  const missions = [
    { pixelOpportunitaId: 118, pixelDirettriceId: Number(byOpportunity.get(118).direttrice_id),
      pixelVersione: Number(byOpportunity.get(118).versione), corridoioPixelId: String(byOpportunity.get(118).engine_id),
      nodes, legs: missionLegs, departure: start1, arrival: end1, requests: localA },
    { pixelOpportunitaId: 120, pixelDirettriceId: Number(byOpportunity.get(120).direttrice_id),
      pixelVersione: Number(byOpportunity.get(120).versione), corridoioPixelId: String(byOpportunity.get(120).engine_id),
      nodes, legs: missionLegs, departure: start2, arrival: end2, requests: localD }
  ];

  // Solo record transitorio nella stessa transazione. Nessuna offerta, nessuna richiesta aggiornata.
  // Il piano e' marcato esplicitamente come fixture non attivabile.
  const { rows: activations } = await client.query(`
    INSERT INTO public.popbus_attivazioni
      (direttrice_id, pixel_opportunita_id, veicolo_id, autista_id, stato,
       partenza, arrivo, costo, ricavo, tariffa, piano, expires_at)
    VALUES (NULL, $1, $2, $3, 'in_attesa_autista', $4, $5, $6, $7, $8, $9::jsonb, NOW() + INTERVAL '5 minutes')
    RETURNING id
  `, [118, Number(v.id), Number(v.driver_id), toDate(start1), toDate(end2),
    98.81, gross, 0.60, JSON.stringify(plan)]);
  insertedId = activations[0]?.id;
  assert(insertedId != null, 'Attivazione fixture creata SOLO nella transazione');
  const missionIds = await registraMissioniAttivazione(client, {
    attivazioneId: insertedId, missioni: missions, pianoGlobale: plan
  });
  assert(missionIds.length === 2, 'Due missioni registrate sotto una sola attivazione');

  const { rows: persistedMissions } = await client.query(`
    SELECT ordine, pixel_opportunita_id, nodi_territoriali
      FROM public.popbus_attivazione_missioni
     WHERE attivazione_id = $1 ORDER BY ordine
  `, [insertedId]);
  assert(same(persistedMissions.map(m => Number(m.ordine)), [1, 2]), 'Ordine missioni 1,2');
  assert(same(persistedMissions.map(m => Number(m.pixel_opportunita_id)), [118, 120]), 'Provenienza PIXEL 118,120');
  assert(persistedMissions.every(m => same(m.nodi_territoriali.map(Number), nodes)), 'Nodi missione coerenti');

  const { rows: localRows } = await client.query(`
    SELECT mr.richiesta_id, mr.indice_salita, mr.indice_discesa
      FROM public.popbus_missione_richieste mr
      JOIN public.popbus_attivazione_missioni m ON m.id = mr.missione_id
     WHERE m.attivazione_id = $1
  `, [insertedId]);
  const { rows: globalRows } = await client.query(`
    SELECT richiesta_id, indice_salita, indice_discesa
      FROM public.popbus_attivazione_richieste WHERE attivazione_id = $1
  `, [insertedId]);
  assert(localRows.length === 6 && globalRows.length === 6, 'Sei associazioni locali e sei globali');
  const globalMap = new Map(globalRows.map(r => [Number(r.richiesta_id), r]));
  assert(globalRequests.every(r => {
    const actual = globalMap.get(r.id);
    return actual && Number(actual.indice_salita) === r.start && Number(actual.indice_discesa) === r.end;
  }), 'Indici globali esatti per tutte le richieste');
  assert(same(sortNums(localRows.map(r => r.richiesta_id)), sortNums(allIds)), 'Indici locali senza perdita o duplicazione richieste');
  console.log('PASS PERSISTENZA STRUTTURALE — ora ROLLBACK obbligatorio');
} catch (error) {
  testError = error;
  console.error('FAIL P0-C8.16A:', error.message);
} finally {
  if (client) {
    if (inTx) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK completato');
      } catch (error) {
        console.error('ERRORE ROLLBACK:', error.message);
        testError ??= error;
      }
    }
    if (insertedId != null && !testError) {
      try {
        const { rows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM public.popbus_attivazioni WHERE id=$1', [insertedId]);
        assert(rows[0].n === 0, 'Verifica post-rollback: attivazione inesistente');
      } catch (error) {
        testError ??= error;
        console.error('FAIL verifica post-rollback:', error.message);
      }
    }
    client.release(testError ? new Error('P0-C8.16A: connessione scartata per precauzione') : undefined);
  }
  await pool.end();
}
if (testError) process.exitCode = 1;
else console.log('ESITO: PASS — SOLO persistenza strutturale. Nessuna attivazione operativa.');
