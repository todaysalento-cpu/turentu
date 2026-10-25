// TURENTU POPBUS V2
// Generazione progressiva delle assegnazioni alle fermate fisiche.
// Nessuna query DB, nessuna chiamata routing, nessuna attivazione.

const fail = message => {
  throw new Error(`POPBUS_STOP_ASSIGNMENT: ${message}`);
};

const validId = value =>
  value != null &&
  value !== '' &&
  typeof value !== 'boolean' &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;

const validCoordinate = (lat, lon) =>
  Number.isFinite(Number(lat)) &&
  Number.isFinite(Number(lon)) &&
  Math.abs(Number(lat)) <= 90 &&
  Math.abs(Number(lon)) <= 180;

function normalizeStop(stop) {
  if (
    !validId(stop?.fermata_id) ||
    !validCoordinate(stop?.lat, stop?.lon) ||
    stop?.distanza_metri == null ||
    !Number.isFinite(Number(stop.distanza_metri)) ||
    Number(stop.distanza_metri) < 0
  ) {
    fail('fermata candidata non valida');
  }

  return {
    ...stop,
    fermata_id: Number(stop.fermata_id),
    lat: Number(stop.lat),
    lon: Number(stop.lon),
    distanza_metri: Number(stop.distanza_metri)
  };
}

function compatibleStops(stops, tipoVeicolo) {
  if (!Array.isArray(stops)) {
    fail('lista fermate non valida');
  }

  const unique = new Map();

  for (const raw of stops) {
    const stop = normalizeStop(raw);

    if (!Array.isArray(stop.tipi_veicolo_ammessi)) {
      continue;
    }

    // Fase provvisoria:
    // array vuoto = compatibilità non ancora dichiarata,
    // non esclusione automatica dal collaudo.
    // Se sono presenti tipi espliciti, il veicolo deve essere ammesso.
    if (
      stop.tipi_veicolo_ammessi.length > 0 &&
      !stop.tipi_veicolo_ammessi.includes(tipoVeicolo)
    ) {
      continue;
    }

    const previous = unique.get(stop.fermata_id);

    if (
      !previous ||
      stop.distanza_metri < previous.distanza_metri
    ) {
      unique.set(stop.fermata_id, stop);
    }
  }

  return [...unique.values()].sort(
    (a, b) =>
      a.distanza_metri - b.distanza_metri ||
      a.fermata_id - b.fermata_id
  );
}

function pairKey(assegnazione) {
  return `${assegnazione.salita.fermata_id}:${assegnazione.discesa.fermata_id}`;
}

function comparePairs(a, b) {
  const da = a.salita.distanza_metri + a.discesa.distanza_metri;
  const db = b.salita.distanza_metri + b.discesa.distanza_metri;

  return (
    da - db ||
    a.salita.fermata_id - b.salita.fermata_id ||
    a.discesa.fermata_id - b.discesa.fermata_id
  );
}

function buildPairs(ref, item, tipoVeicolo) {
  const salite = compatibleStops(item.salita, tipoVeicolo);
  const discese = compatibleStops(item.discesa, tipoVeicolo);

  if (!salite.length || !discese.length) {
    return { motivo: 'FERMATE_COMPATIBILI_ASSENTI', coppie: [] };
  }

  const coppie = [];

  for (const salita of salite) {
    for (const discesa of discese) {
      if (salita.fermata_id === discesa.fermata_id) {
        continue;
      }

      coppie.push({
        richiesta_id: Number(ref.id),
        start_territoriale: Number(ref.start),
        end_territoriale: Number(ref.end),
        ...(ref.posti_richiesti != null
          ? { posti_richiesti: Number(ref.posti_richiesti) }
          : {}),
        salita,
        discesa
      });
    }
  }

  coppie.sort(comparePairs);

  return {
    motivo: coppie.length ? null : 'NESSUNA_COPPIA_FERMATE',
    coppie
  };
}

function evaluatePartial(assegnazioni) {
  const fermate = new Set();
  let distanzaAccesso = 0;

  for (const assegnazione of assegnazioni) {
    fermate.add(assegnazione.salita.fermata_id);
    fermate.add(assegnazione.discesa.fermata_id);

    distanzaAccesso +=
      assegnazione.salita.distanza_metri +
      assegnazione.discesa.distanza_metri;
  }

  return {
    assegnazioni,
    fermate_distinte: fermate.size,
    distanza_accesso_totale_metri: distanzaAccesso,
    scorePreliminare: distanzaAccesso + fermate.size * 250
  };
}

function assignmentKey(assegnazioni) {
  return assegnazioni
    .map(a => `${a.richiesta_id}:${pairKey(a)}`)
    .join('|');
}

function compareStates(a, b) {
  return (
    a.scorePreliminare - b.scorePreliminare ||
    a.fermate_distinte - b.fermate_distinte ||
    a.distanza_accesso_totale_metri - b.distanza_accesso_totale_metri ||
    assignmentKey(a.assegnazioni).localeCompare(
      assignmentKey(b.assegnazioni)
    )
  );
}

export function generaAssegnazioniFermate({
  evaluation,
  candidati,
  tipoVeicolo,
  maxCombinazioni = 100,
  maxEspansioni = 20000
}) {
  if (!Array.isArray(evaluation?.requests) || !evaluation.requests.length) {
    fail('formazione non valida');
  }

  if (!Array.isArray(candidati)) {
    fail('candidati non validi');
  }

  if (!['ncc', 'navetta', 'autobus'].includes(tipoVeicolo)) {
    fail('tipoVeicolo non valido');
  }

  if (
    !Number.isSafeInteger(maxCombinazioni) ||
    maxCombinazioni < 1 ||
    maxCombinazioni > 1000
  ) {
    fail('maxCombinazioni non valido');
  }

  if (
    !Number.isSafeInteger(maxEspansioni) ||
    maxEspansioni < 1 ||
    maxEspansioni > 1000000
  ) {
    fail('maxEspansioni non valido');
  }

  const byRequest = new Map();

  for (const item of candidati) {
    if (!validId(item?.richiesta_id)) {
      fail('ID richiesta candidata non valido');
    }

    const id = Number(item.richiesta_id);

    if (byRequest.has(id)) {
      fail('richiesta candidata duplicata');
    }

    byRequest.set(id, item);
  }

  const alternative = [];
  const seen = new Set();

  for (const ref of evaluation.requests) {
    if (!validId(ref?.id) || seen.has(Number(ref.id))) {
      fail('richiesta della formazione non valida o duplicata');
    }

    const richiestaId = Number(ref.id);
    seen.add(richiestaId);

    const start = Number(ref.start);
    const end = Number(ref.end);

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      fail('indici territoriali non validi');
    }

    if (
      ref.posti_richiesti != null &&
      (!Number.isSafeInteger(Number(ref.posti_richiesti)) ||
        Number(ref.posti_richiesti) <= 0)
    ) {
      fail('posti_richiesti non validi');
    }

    const item = byRequest.get(richiestaId);

    if (!item) {
      return {
        ok: false,
        motivo: 'RICHIESTA_SENZA_CANDIDATI',
        richiestaId,
        combinazioni: []
      };
    }

    const result = buildPairs(ref, item, tipoVeicolo);

    if (!result.coppie.length) {
      return {
        ok: false,
        motivo: result.motivo,
        richiestaId,
        combinazioni: []
      };
    }

    alternative.push(result.coppie);
  }

  // Beam search: ogni livello aggiunge una richiesta alla combinazione.
  // Il limite di espansioni evita di restituire assegnazioni parziali
  // come se fossero combinazioni complete.
  let beam = [evaluatePartial([])];

  let espansioni = 0;
  let potature = 0;
  let budgetRaggiunto = false;

  const livelli = [];

  for (let livello = 0; livello < alternative.length; livello++) {
    const coppie = alternative[livello];
    const nuove = [];
    const remainingBudget = maxEspansioni - espansioni;

    // Se non possiamo espandere almeno uno stato completo per questo
    // livello, interrompiamo senza restituire risultati parziali.
    if (remainingBudget < 1) {
      budgetRaggiunto = true;
      break;
    }

    outer:
    for (const stato of beam) {
      for (const coppia of coppie) {
        if (espansioni >= maxEspansioni) {
          budgetRaggiunto = true;
          break outer;
        }

        nuove.push(
          evaluatePartial([
            ...stato.assegnazioni,
            coppia
          ])
        );

        espansioni++;
      }
    }

    if (!nuove.length) {
      budgetRaggiunto = true;
      break;
    }

    nuove.sort(compareStates);

    const before = nuove.length;
    beam = nuove.slice(0, maxCombinazioni);
    potature += before - beam.length;

    livelli.push({
      livello: livello + 1,
      coppieDisponibili: coppie.length,
      statiGenerati: before,
      statiConservati: beam.length
    });

    // Si tenta il livello successivo con il budget residuo.
  }

  const completa = livelli.length === alternative.length;

  if (!completa) {
    return {
      ok: false,
      motivo: 'RICERCA_INCOMPLETA',
      combinazioni: [],
      diagnostica: {
        richiesteTotali: alternative.length,
        livelliCompletati: livelli.length,
        espansioni,
        potature,
        budgetRaggiunto,
        ricercaEsaustiva: false,
        livelli
      }
    };
  }

  beam.sort(compareStates);

  const ricercaEsaustiva = potature === 0 && !budgetRaggiunto;

  return {
    ok: true,
    stato: 'DA_VALIDARE_SU_STRADA',
    combinazioni: beam,
    diagnostica: {
      richiesteTotali: alternative.length,
      combinazioniRestituite: beam.length,
      espansioni,
      potature,
      budgetRaggiunto,
      ricercaEsaustiva,
      livelli
    }
  };
}
