
import { TOLLERANZA_MS } from './model.js';
import { verificaCompatibilitaTemporaleFermate }
  from './popbus-stop-temporal.service.js';

const toMillis = value => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    return new Date(value).getTime();
  }
  return NaN;
};

export function diagnosticaDepartureFermate({
  itinerario,
  richieste,
  tolleranzaMs = TOLLERANZA_MS
}) {
  if (
    !itinerario?.ok ||
    !Number.isFinite(itinerario.departure) ||
    !Array.isArray(itinerario.visite) ||
    !Array.isArray(richieste) ||
    !richieste.length ||
    !Number.isFinite(tolleranzaMs) ||
    tolleranzaMs < 0
  ) {
    throw new Error('DEPARTURE_SHADOW: input non valido');
  }

  const byId = new Map();

  for (const richiesta of richieste) {
    const id = Number(richiesta.id);
    const desiderato = toMillis(richiesta.start_datetime);

    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      byId.has(id) ||
      !Number.isFinite(desiderato)
    ) {
      throw new Error('DEPARTURE_SHADOW: richiesta non valida');
    }

    byId.set(id, desiderato);
  }

  const salite = new Map();
  let departureMin = -Infinity;
  let departureMax = Infinity;

  for (const visita of itinerario.visite) {
    if (!Array.isArray(visita.eventi)) {
      throw new Error('DEPARTURE_SHADOW: visita non valida');
    }

    for (const evento of visita.eventi) {
      if (evento.tipo !== 'salita') continue;

      const id = Number(evento.richiesta_id);
      const effettivo = evento.timestampOperazione;

      if (
        !byId.has(id) ||
        salite.has(id) ||
        !Number.isFinite(effettivo)
      ) {
        throw new Error('DEPARTURE_SHADOW: salita non valida');
      }

      const desiderato = byId.get(id);
      const offset = effettivo - itinerario.departure;

      const minimo = desiderato - tolleranzaMs - offset;
      const massimo = desiderato + tolleranzaMs - offset;

      departureMin = Math.max(departureMin, minimo);
      departureMax = Math.min(departureMax, massimo);

      salite.set(id, {
        richiestaId: id,
        fermataId: Number(visita.fermata_id),
        desiderato,
        effettivo,
        offset,
        departureMin: minimo,
        departureMax: massimo
      });
    }
  }

  if (salite.size !== byId.size) {
    return {
      ok: false,
      motivo: 'SALITA_MANCANTE',
      attivabile: false
    };
  }

  if (departureMin > departureMax) {
    return {
      ok: false,
      motivo: 'NESSUNA_INTERSEZIONE_TEMPORALE',
      departureMin,
      departureMax,
      attivabile: false
    };
  }

  const departureOttimizzato = Math.max(
    departureMin,
    Math.min(itinerario.departure, departureMax)
  );

  // Traslazione temporale dello stesso itinerario.
  // Non cambia fermate, percorso, distanze o capienza.
  const delta = departureOttimizzato - itinerario.departure;

  const itinerarioOttimizzato = {
    ...itinerario,
    departure: departureOttimizzato,
    arrival: itinerario.arrival + delta,
    fineOperazioni: itinerario.fineOperazioni + delta,
    visite: itinerario.visite.map(visita => ({
      ...visita,
      arrivo: visita.arrivo + delta,
      partenza: visita.partenza + delta,
      eventi: visita.eventi.map(evento => ({
        ...evento,
        timestampOperazione:
          evento.timestampOperazione + delta
      }))
    }))
  };

  const verifica = verificaCompatibilitaTemporaleFermate({
    itinerario: itinerarioOttimizzato,
    richieste,
    tolleranzaMs
  });

  return {
    ok: verifica.ok,
    motivo: verifica.ok
      ? 'COMPATIBILE_CON_DEPARTURE_OTTIMIZZATO'
      : verifica.motivo,
    departureOriginale: itinerario.departure,
    departureOttimizzato,
    departureMin,
    departureMax,
    spostamentoMinuti: delta / 60000,
    recuperabileTemporalmente:
      verifica.ok && delta !== 0,
    itinerarioOttimizzato,
    verifica,
    attivabile: false
  };
}
