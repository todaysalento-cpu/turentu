
import {
  verificaQualitaOccorrenze
} from './service-quality.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_QUALITY: ${message}`);
};

const validId = value =>
  value != null &&
  value !== '' &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;

export function verificaQualitaFermate({
  itinerario,
  richieste,
  options = {}
}) {
  if (!itinerario?.ok ||
      !Array.isArray(itinerario.visite) ||
      itinerario.visite.length < 2 ||
      !Array.isArray(itinerario.legs) ||
      itinerario.legs.length !== itinerario.visite.length - 1) {
    fail('itinerario non valido');
  }

  if (!Array.isArray(richieste) || !richieste.length) {
    fail('richieste non valide');
  }

  const byId = new Map();

  for (const richiesta of richieste) {
    if (!validId(richiesta?.id)) {
      fail('ID richiesta non valido');
    }

    const id = Number(richiesta.id);

    if (byId.has(id)) {
      fail('richiesta duplicata');
    }

    byId.set(id, richiesta);
  }

  const nodes = [];
  const assignmentsById = new Map();

  for (let i = 0; i < itinerario.visite.length; i++) {
    const visita = itinerario.visite[i];

    if (!validId(visita.fermata_id) ||
        !Array.isArray(visita.eventi)) {
      fail('visita non valida');
    }

    const fermataId = Number(visita.fermata_id);

    nodes.push(fermataId);

    for (const evento of visita.eventi) {
      const id = Number(evento.richiesta_id);

      if (!byId.has(id)) {
        fail(`richiesta sconosciuta: ${id}`);
      }

      if (!['salita', 'discesa'].includes(evento.tipo)) {
        fail('tipo evento non valido');
      }

      let assignment = assignmentsById.get(id);

      if (!assignment) {
        assignment = {
          richiesta: byId.get(id),
          start: null,
          end: null
        };

        assignmentsById.set(id, assignment);
      }

      if (evento.tipo === 'salita') {
        if (assignment.start !== null) {
          fail(`salita duplicata: ${id}`);
        }

        assignment.start = i;
      } else {
        if (assignment.end !== null) {
          fail(`discesa duplicata: ${id}`);
        }

        assignment.end = i;
      }
    }
  }

  const assignments = [];

  for (const [id, richiesta] of byId) {
    const assignment = assignmentsById.get(id);

    if (!assignment ||
        assignment.start === null ||
        assignment.end === null ||
        assignment.start >= assignment.end) {
      fail(`assegnazione incompleta: ${id}`);
    }

    // Copia della richiesta con nodi operativi.
    // Non modifica i nodi territoriali presenti nel DB.
    assignments.push({
      richiesta: {
        ...richiesta,
        start_node_id: nodes[assignment.start],
        end_node_id: nodes[assignment.end]
      },
      start: assignment.start,
      end: assignment.end
    });
  }

  const legs = itinerario.legs.map((leg, i) => {
    const metres = Number(leg.metres);
    const seconds = Number(leg.seconds);

    if (!Number.isFinite(metres) ||
        !Number.isFinite(seconds) ||
        metres < 0 ||
        seconds < 0) {
      fail(`segmento non valido: ${i}`);
    }

    return {
      metres,
      seconds,
      roadCoincident:
        leg.roadCoincident === true ||
        (leg.coincidente === true &&
         metres === 0 &&
         seconds === 0)
    };
  });

  const plan = { nodes, legs };

  // Tutte le visite rappresentano fermate effettive.
  const stops = nodes.map((_, i) => i);

  const risultato = verificaQualitaOccorrenze(
    plan,
    assignments,
    {
      ...options,
      stops
    }
  );

  if (!risultato.ok) {
    return {
      ...risultato,
      stato: 'QUALITA_NON_CONFORME',
      attivabile: false
    };
  }

  // Il motore legacy considera i tempi di viaggio
  // dei segmenti, ma non le soste intermedie.
  // Verifichiamo anche il tempo effettivo a bordo.
  for (const assignment of assignments) {
    const r = assignment.richiesta;

    if (r.max_ritardo_minuti == null ||
        r.tempo_diretto_secondi == null) {
      continue;
    }

    const maxDelay = Number(r.max_ritardo_minuti);
    const directSeconds = Number(r.tempo_diretto_secondi);

    if (!Number.isFinite(maxDelay) || maxDelay < 0 ||
        !Number.isFinite(directSeconds) ||
        directSeconds <= 0) {
      fail(`parametri temporali non validi: ${r.id}`);
    }

    const salita = itinerario.visite[assignment.start];
    const discesa = itinerario.visite[assignment.end];

    if (!Number.isFinite(salita.partenza) ||
        !Number.isFinite(discesa.arrivo)) {
      fail(`orari operativi mancanti: ${r.id}`);
    }

    const tempoBordoSecondi =
      (discesa.arrivo - salita.partenza) / 1000;

    if (tempoBordoSecondi < 0) {
      fail(`tempo a bordo negativo: ${r.id}`);
    }

    if (tempoBordoSecondi >
        directSeconds + maxDelay * 60) {
      return {
        ok: false,
        stato: 'QUALITA_NON_CONFORME',
        motivo: 'RITARDO_OPERATIVO_ECCESSIVO',
        richiestaId: Number(r.id),
        tempoBordoSecondi,
        massimoSecondi:
          directSeconds + maxDelay * 60,
        attivabile: false
      };
    }
  }

  return {
    ok: true,
    stato: 'QUALITA_FERMATE_PRELIMINARE',
    dettagli: risultato.dettagli,
    attivabile: false
  };
}
