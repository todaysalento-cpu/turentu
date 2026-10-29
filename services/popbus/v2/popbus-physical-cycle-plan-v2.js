
import { componiCicloInCorsa } from './popbus-single-corsa-assembler.js';

const fail = message => {
  throw new Error(`POPBUS_PHYSICAL_PLAN_V2: ${message}`);
};

const positive = value =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function preparaPianoCicloFisicoV2({
  ciclo,
  richiesteBloccate,
  postiTotali
} = {}) {
  if (!ciclo || !positive(ciclo.vehicleId) ||
      !Array.isArray(ciclo.missioni) ||
      ciclo.missioni.length < 1 ||
      ciclo.missioni.length > 2 ||
      !ciclo.routingFisico) {
    fail('ciclo fisico non valido');
  }

  if (!positive(postiTotali)) fail('capienza non valida');

  const dbById = new Map();

  for (const r of richiesteBloccate ?? []) {
    if (!positive(r.id) || dbById.has(Number(r.id)) ||
        !positive(r.posti_richiesti)) {
      fail('richieste DB non valide');
    }
    dbById.set(Number(r.id), r);
  }

  const ids = ciclo.richiestaIds.map(Number);

  if (!ids.length || new Set(ids).size !== ids.length ||
      ids.some(id => !dbById.has(id)) ||
      dbById.size !== ids.length) {
    fail('richieste bloccate discordanti');
  }

  const nodiById = new Map();

  const missioni = ciclo.missioni.map(m => {
    if (m.schemaVersion !== 2 ||
        m.tipoItinerario !== 'FERMATE_FISICHE' ||
        !Array.isArray(m.plan?.nodes) ||
        !Array.isArray(m.plan?.legs) ||
        !Array.isArray(m.evaluation?.requests)) {
      fail('contratto missione fisica V2 incompleto');
    }

    for (const n of m.nodiFisici ?? []) {
      if (!positive(n.id)) fail('fermata fisica non valida');

      const previous = nodiById.get(Number(n.id));
      if (previous &&
          (Number(previous.lat) !== Number(n.lat) ||
           Number(previous.lon) !== Number(n.lon))) {
        fail('coordinate fermata discordanti');
      }

      nodiById.set(Number(n.id), n);
    }

    const requests = m.evaluation.requests.map(ref => {
      const r = dbById.get(Number(ref.id));

      if (!r) fail('richiesta non trovata');

      return {
        id: Number(ref.id),
        start: Number(ref.start),
        end: Number(ref.end),
        posti_richiesti: Number(r.posti_richiesti)
      };
    });

    return {
      nodes: m.plan.nodes,
      legs: m.plan.legs,
      requests,
      departure: m.departure,
      arrival: m.arrival,
      corridorId: m.corridoioPixelId
    };
  });

  const transfer = ciclo.routingFisico.transfer;

  const trasferimenti = missioni.length === 2
    ? [{
        seconds: Number(transfer?.seconds),
        metres: Number(transfer?.metres),
        leg: transfer,
        attesaMinuti:
          Number(ciclo.routingFisico.waitingHours) * 60
      }]
    : [];

  const piano = componiCicloInCorsa({
    missioni,
    trasferimenti,
    nodi: [...nodiById.values()],
    veicoloId: ciclo.vehicleId,
    busyStart: ciclo.partenzaBase,
    busyEnd: ciclo.ritornoBase,
    approach: ciclo.routingFisico.approach,
    returnTrip: ciclo.routingFisico.returnTrip,
    postiTotali: Number(postiTotali),
    contrattoTrasferimentiFisiciV2: true
  });

  if (piano.validazioneCapienza?.verificata !== true) {
    fail('capienza non certificata');
  }

  return {
    ...piano,
    schemaVersion: 2,
    tipoItinerario: 'FERMATE_FISICHE',
    attivabile: false
  };
}
