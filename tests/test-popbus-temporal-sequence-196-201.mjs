// TURENTU POPBUS V2 - Diagnostica temporale completa preliminare richieste 196-201.
// SOLO LETTURA DB + routing reale. Nessuna scrittura, nessuna attivazione.
// Eseguire dalla root:
// node --env-file=.env tests\test-popbus-temporal-sequence-196-201.mjs

import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

const IDS = [196, 197, 198, 199, 200, 201];
const RADIUS_METRES = Number(process.env.POPBUS_STOP_RADIUS_METRES ?? 1500);
const TOLERANCE_MIN = Number(process.env.POPBUS_TEMPORAL_TOLERANCE_MIN ?? 30);
const DWELL_SECONDS = Number(process.env.POPBUS_TEMPORAL_MAGLIE_DWELL_SECONDS ?? 50);

const STOPS = {
  16: { id: 16, name: 'Tricase - Stazione candidata', nodeId: 8, lat: 39.933450, lon: 18.352500 },
  14: { id: 14, name: 'Maglie - Piazzale Megapark', nodeId: 5, lat: 40.121583, lon: 18.305914 },
  15: { id: 15, name: 'Maglie - Stazione ferroviaria', nodeId: 5, lat: 40.1258486502909, lon: 18.299920672780097 },
  17: { id: 17, name: 'Lecce - Stazione candidata', nodeId: 7, lat: 40.345680, lon: 18.165720 }
};

const SCENARIOS = [
  { name: 'VIA_MEGAPARK_14', middle: STOPS[14] },
  { name: 'VIA_STAZIONE_15', middle: STOPS[15] }
];

function localTime(ms) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date(ms));
}
function round(n, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round(Number(n) * p) / p;
}
function distanceMetres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function validPositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

async function main() {
  if (!Number.isFinite(RADIUS_METRES) || RADIUS_METRES <= 0 ||
      !Number.isFinite(TOLERANCE_MIN) || TOLERANCE_MIN < 0 ||
      !Number.isFinite(DWELL_SECONDS) || DWELL_SECONDS < 0) {
    throw new Error('Raggio, tolleranza o sosta non validi');
  }

  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;

    const { rows } = await client.query(`
      SELECT
        id,
        origine_nodo_territoriale_id,
        destinazione_nodo_territoriale_id,
        ST_Y(origine::geometry) AS origine_lat,
        ST_X(origine::geometry) AS origine_lon,
        ST_Y(destinazione::geometry) AS destinazione_lat,
        ST_X(destinazione::geometry) AS destinazione_lon,
        start_datetime,
        posti_richiesti,
        stato,
        classe,
        ar_vincolata,
        ar_tratta,
        ar_group_id
      FROM public.richieste_pop_bus
      WHERE id = ANY($1::int[])
      ORDER BY id
    `, [IDS]);

    const byId = new Map(rows.map(r => [Number(r.id), r]));
    const missing = IDS.filter(id => !byId.has(id));
    if (missing.length) throw new Error(`Richieste mancanti: ${missing.join(', ')}`);

    const requests = IDS.map(id => byId.get(id));
    console.log('TURENTU - DIAGNOSTICA SEQUENZA TEMPORALE');
    console.log('DB READ ONLY; routing reale; nessuna scrittura o attivazione.');
    console.log('Nodi letti dai campi territoriali, non da start_node_id/end_node_id.');
    console.log('RICHIESTE', JSON.stringify(requests.map(r => ({
      id: Number(r.id),
      origineNodoTerritoriale: Number(r.origine_nodo_territoriale_id),
      destinazioneNodoTerritoriale: Number(r.destinazione_nodo_territoriale_id),
      origine: { lat: Number(r.origine_lat), lon: Number(r.origine_lon) },
      destinazione: { lat: Number(r.destinazione_lat), lon: Number(r.destinazione_lon) },
      partenzaUTC: new Date(r.start_datetime).toISOString(),
      partenzaItalia: localTime(new Date(r.start_datetime).getTime()),
      posti: Number(r.posti_richiesti),
      stato: r.stato,
      classe: r.classe,
      arVincolata: r.ar_vincolata,
      arTratta: r.ar_tratta,
      arGroupId: r.ar_group_id
    })), null, 2));

    const routeCache = new Map();
    let routingCalls = 0;
    async function getLeg(a, b) {
      const key = `${a.id}>${b.id}`;
      if (!routeCache.has(key)) {
        routingCalls++;
        const result = await leg(
          { lat: Number(a.lat), lon: Number(a.lon) },
          { lat: Number(b.lat), lon: Number(b.lon) }
        );
        if (!result || !Number.isFinite(Number(result.metres)) ||
            !Number.isFinite(Number(result.seconds)) ||
            Number(result.metres) <= 0 || Number(result.seconds) <= 0) {
          throw new Error(`Routing non valido per tratta ${key}`);
        }
        routeCache.set(key, result);
      }
      return routeCache.get(key);
    }

    const expectedNodeByRequest = {
      196: [8, 5], 197: [5, 7], 198: [8, 7],
      199: [8, 5], 200: [5, 7], 201: [8, 7]
    };
    const mappingDiagnostics = requests.map(r => {
      const expected = expectedNodeByRequest[Number(r.id)];
      const actual = [
        Number(r.origine_nodo_territoriale_id),
        Number(r.destinazione_nodo_territoriale_id)
      ];
      const coordsValid = [
        Number.isFinite(Number(r.origine_lat)), Number.isFinite(Number(r.origine_lon)),
        Number.isFinite(Number(r.destinazione_lat)), Number.isFinite(Number(r.destinazione_lon))
      ].every(Boolean);
      return {
        richiestaId: Number(r.id),
        nodiTerritorialiEffettivi: actual,
        nodiAttesiPerQuestoScenario: expected,
        nodiCoerenti: actual[0] === expected[0] && actual[1] === expected[1],
        coordinatePresenti: coordsValid
      };
    });

    const results = [];
    for (const scenario of SCENARIOS) {
      const stopSequence = [STOPS[16], scenario.middle, STOPS[17]];
      const physicalLegs = [
        await getLeg(stopSequence[0], stopSequence[1]),
        await getLeg(stopSequence[1], stopSequence[2])
      ];

      const pickupAssignments = [
        { requestId: 196, stop: STOPS[16], kind: 'salita' },
        { requestId: 198, stop: STOPS[16], kind: 'salita' },
        { requestId: 197, stop: scenario.middle, kind: 'salita' },
        { requestId: 199, stop: STOPS[16], kind: 'salita' },
        { requestId: 201, stop: STOPS[16], kind: 'salita' },
        { requestId: 200, stop: scenario.middle, kind: 'salita' }
      ];
      const dropAssignments = [
        { requestId: 196, stop: scenario.middle, kind: 'discesa' },
        { requestId: 197, stop: STOPS[17], kind: 'discesa' },
        { requestId: 198, stop: STOPS[17], kind: 'discesa' },
        { requestId: 199, stop: scenario.middle, kind: 'discesa' },
        { requestId: 200, stop: STOPS[17], kind: 'discesa' },
        { requestId: 201, stop: STOPS[17], kind: 'discesa' }
      ];

      const proximity = [];
      for (const assignment of [...pickupAssignments, ...dropAssignments]) {
        const r = byId.get(assignment.requestId);
        const isPickup = assignment.kind === 'salita';
        const point = isPickup
          ? { lat: Number(r.origine_lat), lon: Number(r.origine_lon) }
          : { lat: Number(r.destinazione_lat), lon: Number(r.destinazione_lon) };
        const metres = distanceMetres(point, assignment.stop);
        proximity.push({
          richiestaId: assignment.requestId,
          tipo: assignment.kind,
          fermataId: assignment.stop.id,
          fermata: assignment.stop.name,
          distanzaMetri: Math.round(metres),
          entroRaggio: metres <= RADIUS_METRES
        });
      }

      for (const wave of [
        { name: 'ONDATA_1', startIds: [196, 198], magliePickupId: 197, baseId: 196 },
        { name: 'ONDATA_2', startIds: [199, 201], magliePickupId: 200, baseId: 199 }
      ]) {
        const base = byId.get(wave.baseId);
        const departureMs = new Date(base.start_datetime).getTime();
        const arrivalMiddleMs = departureMs + Number(physicalLegs[0].seconds) * 1000;
        const requestedMiddleMs = new Date(byId.get(wave.magliePickupId).start_datetime).getTime();
        const earliestDepartureMiddleMs = arrivalMiddleMs + DWELL_SECONDS * 1000;
        const actualDepartureMiddleMs = Math.max(earliestDepartureMiddleMs, requestedMiddleMs);
        const arrivalDestinationMs = actualDepartureMiddleMs + Number(physicalLegs[1].seconds) * 1000;
        const arrivalDeltaMin = (arrivalMiddleMs - requestedMiddleMs) / 60000;
        const pickupTimeCompatible = arrivalDeltaMin <= TOLERANCE_MIN &&
          arrivalDeltaMin >= -TOLERANCE_MIN;
        const waitSeconds = Math.max(0, (requestedMiddleMs - earliestDepartureMiddleMs) / 1000);
        const endIds = wave.name === 'ONDATA_1' ? [196, 197, 198] : [199, 200, 201];

        results.push({
          scenario: scenario.name,
          ondata: wave.name,
          percorsoFermate: stopSequence.map(s => ({ id: s.id, nome: s.name })),
          tratte: physicalLegs.map((l, i) => ({
            da: stopSequence[i].id,
            a: stopSequence[i + 1].id,
            km: round(Number(l.metres) / 1000),
            minuti: round(Number(l.seconds) / 60)
          })),
          partenzaTricaseItalia: localTime(departureMs),
          arrivoMaglieItalia: localTime(arrivalMiddleMs),
          orarioRichiestoPickupMaglieItalia: localTime(requestedMiddleMs),
          scartoArrivoMaglieMinuti: round(arrivalDeltaMin),
          pickupMaglieEntroTolleranza: pickupTimeCompatible,
          sostaMaglieSecondi: DWELL_SECONDS,
          attesaAggiuntivaPrimaDellaPartenzaSecondi: Math.round(waitSeconds),
          partenzaEffettivaMaglieItalia: localTime(actualDepartureMiddleMs),
          arrivoStimatoLecceItalia: localTime(arrivalDestinationMs),
          richiesteNellOndata: endIds,
          prossimitaFermate: proximity,
          tutteLeSaliteDiscesaEntroRaggio: proximity.every(p => p.entroRaggio),
          nodiTerritorialiCoerenti: mappingDiagnostics.every(x => x.nodiCoerenti && x.coordinatePresenti),
          compatibilitaTemporalePreliminare: pickupTimeCompatible &&
            proximity.every(p => p.entroRaggio) &&
            mappingDiagnostics.every(x => x.nodiCoerenti && x.coordinatePresenti),
          nota: 'Non certifica ordine completo di tutti gli eventi, capienza lungo ogni segmento, qualità minima, idoneità legale del punto di accosto o remunerazione dell’intero ciclo.'
        });
      }
    }

    console.log('DIAGNOSTICA_NODI', JSON.stringify(mappingDiagnostics, null, 2));
    console.log('RISULTATI', JSON.stringify({
      raggioFermataMetri: RADIUS_METRES,
      tolleranzaTemporaleMinuti: TOLERANCE_MIN,
      sostaMaglieSecondi: DWELL_SECONDS,
      routingEffettivoChiamate: routingCalls,
      risultati: results,
      tutteLeMappatureNodiCoerenti: mappingDiagnostics.every(x => x.nodiCoerenti && x.coordinatePresenti),
      tutteLeCombinazioniPreliminariCompatibili: results.every(x => x.compatibilitaTemporalePreliminare),
      dbWrites: 0,
      attivabile: false
    }, null, 2));
    console.log('ESITO=DIAGNOSTICA_COMPLETATA_NON_CERTIFICANTE');
  } finally {
    if (transaction) {
      try { await client.query('ROLLBACK'); }
      catch (error) { console.error('ROLLBACK FALLITO', error); process.exitCode = 1; }
    }
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error('FAIL DIAGNOSTICA SEQUENZA TEMPORALE:', error.stack || error);
  process.exitCode = 1;
});
