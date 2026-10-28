
// TURENTU POPBUS V2
// Preflight delle missioni con fermate fisiche.
// Nessuna scrittura DB. Nessuna attivazione LIVE.

import { TOLLERANZA_MS } from './model.js';
import { verificaCompatibilitaTemporaleFermate } from './popbus-stop-temporal.service.js';
import { verificaQualitaFermate } from './popbus-stop-quality.service.js';

const fail = message => {
  throw new Error(`POPBUS_PHYSICAL_PREFLIGHT: ${message}`);
};

const validId = value =>
  value != null &&
  value !== '' &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;

const finite = value =>
  typeof value === 'number' && Number.isFinite(value);

const millis = value => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    return new Date(value).getTime();
  }
  return NaN;
};

const near = (a, b) =>
  finite(a) && finite(b) && Math.abs(a - b) <= 1;

export function validaMissioneFisicaPreflight({
  missione,
  richiesteBloccate,
  postiTotali,
  tolleranzaMs = TOLLERANZA_MS
} = {}) {
  if (
    missione?.schemaVersion !== 2 ||
    missione?.tipoItinerario !== 'FERMATE_FISICHE'
  ) {
    fail('contratto fisico V2 assente');
  }

  const nodes = missione.plan?.nodes;
  const legs = missione.plan?.legs;
  const refs = missione.evaluation?.requests;
  const itinerario = missione.validazioneFisica?.itinerario;

  if (
    !Array.isArray(nodes) ||
    nodes.length < 2 ||
    nodes.some(n => !validId(n)) ||
    !Array.isArray(legs) ||
    legs.length !== nodes.length - 1 ||
    !Array.isArray(refs) ||
    !refs.length
  ) {
    fail('piano fisico incompleto');
  }

  if (
    !Array.isArray(richiesteBloccate) ||
    !Number.isSafeInteger(postiTotali) ||
    postiTotali < 1 ||
    !finite(tolleranzaMs) ||
    tolleranzaMs < 0
  ) {
    fail('parametri non validi');
  }

  if (
    !itinerario?.ok ||
    itinerario.routingVerificato !== true ||
    !Array.isArray(itinerario.visite) ||
    !Array.isArray(itinerario.legs)
  ) {
    fail('itinerario fisico certificato assente');
  }

  const byId = new Map();

  for (const r of richiesteBloccate) {
    if (!validId(r?.id) || byId.has(Number(r.id))) {
      fail('richiesta DB duplicata o non valida');
    }
    byId.set(Number(r.id), r);
  }

  if (byId.size !== refs.length) {
    fail('insieme richieste discordante');
  }

  const times = [0];
  const occupancy = Array(nodes.length).fill(0);
  const seen = new Set();
  const assignments = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const metres = Number(leg?.metres);
    const seconds = Number(leg?.seconds);

    const road = metres > 0 && seconds > 0;
    const wait =
      leg?.attesa === true &&
      metres === 0 &&
      seconds > 0 &&
      Number(nodes[i]) === Number(nodes[i + 1]);

    const coincident =
      leg?.roadCoincident === true &&
      metres === 0 &&
      seconds === 0;

    if (
      !Number.isFinite(metres) ||
      !Number.isFinite(seconds) ||
      !(road || wait || coincident)
    ) {
      fail(`segmento fisico non valido: ${i}`);
    }

    times.push(times.at(-1) + seconds * 1000);
  }

  const departure = Number(missione.departure);
  const arrival = Number(missione.arrival);

  if (
    !near(departure + times.at(-1), arrival) ||
    !near(departure, itinerario.departure) ||
    !near(arrival, itinerario.fineOperazioni)
  ) {
    fail('cronologia missione incoerente');
  }

  // Ricostruisce le occorrenze direttamente dalle visite originali.
  const expectedNodes = [];
  const expectedEvents = new Map();
  const commercialStops = [];
  let current = itinerario.departure;

  for (let i = 0; i < itinerario.visite.length; i++) {
    const visita = itinerario.visite[i];

    if (
      !validId(visita?.fermata_id) ||
      !finite(visita.arrivo) ||
      !finite(visita.partenza) ||
      !finite(visita.sostaSecondi) ||
      visita.sostaSecondi < 0 ||
      !Array.isArray(visita.eventi) ||
      !visita.eventi.length ||
      !near(visita.arrivo, current) ||
      !near(
        visita.partenza,
        visita.arrivo + visita.sostaSecondi * 1000
      )
    ) {
      fail(`visita fisica incoerente: ${i}`);
    }

    const index = expectedNodes.length;
    expectedNodes.push(Number(visita.fermata_id));
    commercialStops.push(index);

    for (const ev of visita.eventi) {
      const id = Number(ev.richiesta_id);

      if (
        !byId.has(id) ||
        !['salita', 'discesa'].includes(ev.tipo) ||
        !near(Number(ev.timestampOperazione), visita.arrivo) ||
        Number(ev.posti) !== Number(byId.get(id).posti_richiesti)
      ) {
        fail(`evento operativo non valido: ${id}`);
      }

      const event = expectedEvents.get(id) ?? {};

      if (event[ev.tipo] != null) {
        fail(`evento duplicato: ${id}`);
      }

      event[ev.tipo] = index;
      expectedEvents.set(id, event);
    }

    if (visita.sostaSecondi > 0) {
      expectedNodes.push(Number(visita.fermata_id));
    }

    current = visita.partenza;

    if (i < itinerario.legs.length) {
      const leg = itinerario.legs[i];

      if (
        !finite(Number(leg?.seconds)) ||
        Number(leg.seconds) < 0
      ) {
        fail(`percorrenza non valida: ${i}`);
      }

      current += Number(leg.seconds) * 1000;
    }
  }

  if (
    expectedNodes.length !== nodes.length ||
    expectedNodes.some((id, i) => id !== Number(nodes[i])) ||
    !near(current, arrival)
  ) {
    fail('occorrenze fisiche divergenti');
  }

  for (const ref of refs) {
    const id = Number(ref.id);
    const start = Number(ref.start);
    const end = Number(ref.end);
    const r = byId.get(id);
    const original = expectedEvents.get(id);

    if (
      !validId(id) ||
      seen.has(id) ||
      !r ||
      !original ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end >= nodes.length ||
      start >= end ||
      original.salita !== start ||
      original.discesa !== end
    ) {
      fail(`assegnazione fisica non valida: ${id}`);
    }

    seen.add(id);

    const posti = Number(r.posti_richiesti);

    if (
      !Number.isSafeInteger(posti) ||
      posti < 1 ||
      Number(ref.posti_richiesti) !== posti
    ) {
      fail(`posti modificati: ${id}`);
    }

    const prezzoOriginale = missione.requests?.find(
      x => Number(x.id) === id
    )?.prezzo;

    if (
      prezzoOriginale == null ||
      !Number.isFinite(Number(r.prezzo)) ||
      Number(prezzoOriginale) !== Number(r.prezzo)
    ) {
      fail(`prezzo modificato: ${id}`);
    }

    const desiderato = millis(r.start_datetime);
    const effettivo = departure + times[start];

    if (
      !finite(desiderato) ||
      Math.abs(effettivo - desiderato) > tolleranzaMs
    ) {
      fail(`salita fuori tolleranza: ${id}`);
    }

    occupancy[start] += posti;
    occupancy[end] -= posti;

    assignments.push({
      richiesta: {
        ...r,
        start_node_id: Number(nodes[start]),
        end_node_id: Number(nodes[end])
      },
      start,
      end
    });

    // Durata effettiva a bordo, comprese le soste.
    if (
      r.max_ritardo_minuti != null &&
      r.tempo_diretto_secondi != null
    ) {
      const delay = Number(r.max_ritardo_minuti);
      const direct = Number(r.tempo_diretto_secondi);

      if (
        !finite(delay) ||
        delay < 0 ||
        !finite(direct) ||
        direct <= 0
      ) {
        fail(`limiti temporali non validi: ${id}`);
      }

      if (
        (times[end] - times[start]) / 1000 >
        direct + delay * 60
      ) {
        fail(`ritardo operativo eccessivo: ${id}`);
      }
    }
  }

  if (seen.size !== byId.size) {
    fail('richieste non completamente assegnate');
  }

  let onboard = 0;
  let peak = 0;

  for (const delta of occupancy) {
    onboard += delta;

    if (onboard < 0 || onboard > postiTotali) {
      fail('capienza non valida');
    }

    peak = Math.max(peak, onboard);
  }

  if (onboard !== 0) {
    fail('occupazione finale non nulla');
  }

  // Qualita su itinerario stradale originale:
  // le soste vengono considerate dal controllo operativo dedicato.
  const qualita = verificaQualitaFermate({
    itinerario,
    richieste: richiesteBloccate
  });

  if (!qualita.ok) {
    fail('qualita non conforme: ' + qualita.motivo);
  }

  const temporale = verificaCompatibilitaTemporaleFermate({
    itinerario,
    richieste: richiesteBloccate,
    tolleranzaMs
  });

  if (!temporale.ok) {
    fail('compatibilita temporale: ' + temporale.motivo);
  }

  return {
    ok: true,
    schemaVersion: 2,
    tipoItinerario: 'FERMATE_FISICHE',
    numeroRichieste: seen.size,
    peak,
    qualita,
    temporale,
    attivabile: false
  };
}

