
import {
  valutaEconomiaCiclo
} from './cycle-pricing.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_ECONOMICS: ${message}`);
};

const nonNegativo = value =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0;

function metriVerificati(segmento, nome) {
  if (!segmento ||
      segmento.routingVerificato !== true ||
      !nonNegativo(segmento.metres)) {
    fail(`${nome}: routing non verificato`);
  }

  return Number(segmento.metres);
}

function kmMissioneVerificata(missione, indice) {
  if (!missione?.itinerario?.ok ||
      missione.itinerario.routingVerificato !== true ||
      !Array.isArray(missione.itinerario.legs) ||
      !missione.itinerario.legs.length) {
    fail(`missione ${indice}: itinerario non verificato`);
  }

  const legs = missione.itinerario.legs;

  if (!legs.every(l => nonNegativo(l?.metres))) {
    fail(`missione ${indice}: segmenti non validi`);
  }

  if (!missione.temporale?.ok ||
      !missione.qualita?.ok ||
      !missione.sequenza?.ok) {
    fail(`missione ${indice}: controlli incompleti`);
  }

  return legs.reduce(
    (totale, leg) => totale + Number(leg.metres),
    0
  ) / 1000;
}

export function valutaEconomiaFermate({
  missioni,
  avvicinamento,
  trasferimenti = [],
  ritornoBase,
  ricaviRichiesteEuro,
  euroKm,
  oreAttesa = 0,
  costoAttesaOraEuro = 0,
  altriCostiEuro = 0,
  margineMinimoEuro = 0
}) {
  if (!Array.isArray(missioni) || !missioni.length) {
    fail('missioni mancanti');
  }

  if (!Array.isArray(trasferimenti) ||
      trasferimenti.length !== missioni.length - 1) {
    fail('trasferimenti incompleti');
  }

  if (!Array.isArray(ricaviRichiesteEuro) ||
      !ricaviRichiesteEuro.length ||
      !ricaviRichiesteEuro.every(nonNegativo)) {
    fail('ricavi richieste non validi');
  }

  if (!nonNegativo(euroKm)) {
    fail('tariffa NCC non valida');
  }

  const kmAvvicinamento =
    metriVerificati(avvicinamento, 'avvicinamento') / 1000;

  const kmRitornoBase =
    metriVerificati(ritornoBase, 'ritorno base') / 1000;

  const kmMissioni = missioni.reduce(
    (totale, missione, i) =>
      totale + kmMissioneVerificata(missione, i),
    0
  );

  const kmTrasferimenti = trasferimenti.reduce(
    (totale, segmento, i) =>
      totale +
      metriVerificati(
        segmento,
        `trasferimento ${i}`
      ) / 1000,
    0
  );

  const economia = valutaEconomiaCiclo({
    ricaviRichiesteEuro: ricaviRichiesteEuro.map(Number),
    kmAvvicinamento,
    kmMissioni,
    kmTrasferimenti,
    kmRitornoBase,
    euroKm: Number(euroKm),
    oreAttesa,
    costoAttesaOraEuro,
    altriCostiEuro,
    margineMinimoEuro
  });

  return {
    ok: true,
    stato: economia.economicamenteAttivabile
      ? 'SOGLIA_ECONOMICA_RAGGIUNTA'
      : 'SOGLIA_ECONOMICA_NON_RAGGIUNTA',
    economia,
    economicamenteAttivabile:
      economia.economicamenteAttivabile,
    // Restano da verificare gli altri vincoli
    // prima dell'attivazione operativa.
    attivabile: false
  };
}
