import { diagnosticaDepartureFermate }
  from './popbus-stop-departure-optimizer.shadow.js';

const fail = message => {
  throw new Error(`POPBUS_MULTIMISSION_TIME_SHADOW: ${message}`);
};

const finite = x =>
  typeof x === 'number' && Number.isFinite(x);

function finestraMissione({
  itinerario,
  richieste,
  pixelWindow
}) {
  if (!itinerario?.ok ||
      !finite(itinerario.departure) ||
      !finite(itinerario.fineOperazioni) ||
      itinerario.fineOperazioni <= itinerario.departure) {
    fail('itinerario fisico non valido');
  }

  if (!pixelWindow ||
      !finite(pixelWindow.start) ||
      !finite(pixelWindow.end) ||
      pixelWindow.start > pixelWindow.end) {
    fail('finestra PIXEL non valida');
  }

  const diagnosi = diagnosticaDepartureFermate({
    itinerario,
    richieste
  });

  if (!finite(diagnosi.departureMin) ||
      !finite(diagnosi.departureMax) ||
      diagnosi.departureMin > diagnosi.departureMax) {
    return {
      ok: false,
      motivo: diagnosi.motivo,
      attivabile: false
    };
  }

  const lower = Math.max(
    diagnosi.departureMin,
    pixelWindow.start
  );

  const upper = Math.min(
    diagnosi.departureMax,
    pixelWindow.end
  );

  return {
    ok: lower <= upper,
    motivo: lower <= upper
      ? 'FINESTRA_DISPONIBILE'
      : 'NESSUNA_INTERSEZIONE_PIXEL_FISICO',
    lower,
    upper,
    durataMs:
      itinerario.fineOperazioni - itinerario.departure,
    attivabile: false
  };
}

export function diagnosticaCoppiaTemporaleFisicaShadow({
  a,
  b,
  trasferimentoMs
}) {
  if (!finite(trasferimentoMs) || trasferimentoMs < 0) {
    fail('trasferimento non valido');
  }

  const fa = finestraMissione(a);
  const fb = finestraMissione(b);

  if (!fa.ok || !fb.ok) {
    return {
      ok: false,
      motivo: !fa.ok
        ? `MISSIONE_A_${fa.motivo}`
        : `MISSIONE_B_${fb.motivo}`,
      attivabile: false
    };
  }

  const partenzaA = fa.lower;

  const primaPartenzaB = Math.max(
    fb.lower,
    partenzaA + fa.durataMs + trasferimentoMs
  );

  const recuperabileTeoricamente =
    primaPartenzaB <= fb.upper;

  return {
    ok: true,
    recuperabileTeoricamente,
    motivo: recuperabileTeoricamente
      ? 'COPPIA_TEMPORALMENTE_RECUPERABILE'
      : 'NESSUNA_SEQUENZA_TEMPORALE',
    finestraA: fa,
    finestraB: fb,
    partenzaA,
    partenzaB: recuperabileTeoricamente
      ? primaPartenzaB
      : null,
    fineOperazioniA: partenzaA + fa.durataMs,
    trasferimentoMs,
    recuperabileValidato: false,
    attivabile: false
  };
}