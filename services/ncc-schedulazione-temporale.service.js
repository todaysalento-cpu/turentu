// NCC_SCHEDULAZIONE_TEMPORALE_V27

const giornoLocale = new Intl.DateTimeFormat(
  'sv-SE',
  {
    timeZone: 'Europe/Rome',
    dateStyle: 'short'
  }
);

function ms(value) {
  return Date.parse(value);
}

function iso(value) {
  return new Date(value).toISOString();
}

export function finestraServizioNcc(proposta) {

  const inizio = ms(proposta.inizio);
  const fine = ms(proposta.fine);

  if (
    !Number.isFinite(inizio) ||
    !Number.isFinite(fine) ||
    fine <= inizio
  ) return null;

  const f =
    proposta.itinerario?.flessibilitaTemporale;

  if (!f) {
    return {
      minimo: inizio,
      massimo: inizio,
      durataMs: fine - inizio
    };
  }

  if (
    f.versione !== '2.7.1' ||
    f.modalita !== 'TRASLAZIONE_UNIFORME'
  ) return null;

  const minimo = ms(f.inizioMinimo);
  const massimo = ms(f.inizioMassimo);
  const fineMinima = ms(f.fineMinima);
  const fineMassima = ms(f.fineMassima);

  if (
    !Number.isFinite(minimo) ||
    !Number.isFinite(massimo) ||
    !Number.isFinite(fineMinima) ||
    !Number.isFinite(fineMassima) ||
    massimo < minimo ||
    inizio < minimo ||
    inizio > massimo ||
    f.durataMs !== fine - inizio ||
    fineMinima !== minimo + f.durataMs ||
    fineMassima !== massimo + f.durataMs ||
    f.posticipoMassimoMs !== massimo - minimo
  ) return null;

  return {
    minimo,
    massimo,
    durataMs: f.durataMs
  };
}

export function traslaServizioNcc(
  proposta,
  nuovoInizio,
  opzioni = {}
) {

  const verificaAttiva =
    opzioni.verificaAttiva ?? (() => {});

  verificaAttiva();

  const finestra =
    finestraServizioNcc(proposta);

  if (
    !finestra ||
    !Number.isSafeInteger(nuovoInizio) ||
    nuovoInizio < finestra.minimo ||
    nuovoInizio > finestra.massimo
  ) return null;

  const precedente = ms(proposta.inizio);

  const delta = nuovoInizio - precedente;

  const nuovaFine =
    nuovoInizio + finestra.durataMs;

  const giorno = giornoLocale.format(
    new Date(finestra.minimo)
  );

  if (
    giornoLocale.format(
      new Date(nuovoInizio)
    ) !== giorno ||
    giornoLocale.format(
      new Date(nuovaFine)
    ) !== giorno
  ) return null;

  const originale = proposta.itinerario;

  if (
    !Array.isArray(originale?.fermate) ||
    !originale.fermate.length
  ) return null;

  if (
    ms(originale.inizio) !== precedente ||
    ms(originale.fine) !== ms(proposta.fine) ||
    ms(originale.arrivoPrevisto) !== ms(proposta.fine)
  ) return null;

  const fermate = [];

  let ultimo = -Infinity;

  for (const fermata of originale.fermate) {

    verificaAttiva();

    const orario = ms(fermata.orario);

    if (
      !Number.isFinite(orario) ||
      orario < precedente ||
      orario > ms(proposta.fine) ||
      orario < ultimo ||
      !['salita', 'discesa'].includes(fermata.tipo)
    ) return null;

    ultimo = orario;

    if (
      fermata.tipo === 'salita' &&
      ms(fermata.prelievo) !== orario
    ) return null;

    if (
      fermata.tipo === 'discesa' &&
      fermata.prelievo !== null
    ) return null;

    fermate.push({
      ...fermata,
      orario: iso(orario + delta),
      prelievo:
        fermata.tipo === 'salita'
          ? iso(orario + delta)
          : null
    });
  }

  const salite = fermate.filter(
    f => f.tipo === 'salita'
  );

  if (!salite.length) return null;

  if (
    ms(fermate[0].orario) !== nuovoInizio ||
    ms(fermate.at(-1).orario) !== nuovaFine ||
    ms(proposta.prelievoDal) !== precedente ||
    ms(proposta.prelievoAl) !==
      ms(salite.at(-1).orario) - delta
  ) return null;

  verificaAttiva();

  return {
    ...proposta,

    inizio: iso(nuovoInizio),
    fine: iso(nuovaFine),

    prelievoDal: salite[0].orario,
    prelievoAl: salite.at(-1).orario,

    itinerario: {
      ...originale,
      inizio: iso(nuovoInizio),
      fine: iso(nuovaFine),
      arrivoPrevisto: iso(nuovaFine),
      fermate
    },

    schedulazioneTemporale: {
      versione: '2.7.2',
      inizioOriginale: iso(finestra.minimo),
      inizioEffettivo: iso(nuovoInizio),
      posticipoMs:
        nuovoInizio - finestra.minimo,
      margineResiduoMs:
        finestra.massimo - nuovoInizio
    },

    approvabile: false
  };
}

export function schedulaSequenzaNcc(
  gruppi,
  trasferimenti,
  opzioni = {}
) {

  const verificaAttiva =
    opzioni.verificaAttiva ?? (() => {});

  verificaAttiva();

  if (
    !Array.isArray(gruppi) ||
    !gruppi.length ||
    !Array.isArray(trasferimenti) ||
    trasferimenti.length !== gruppi.length - 1
  ) return null;

  const finestre = gruppi.map(
    finestraServizioNcc
  );

  if (finestre.some(f => !f)) return null;

  const maxAttesa =
    opzioni.attesaMassimaMs ?? Infinity;

  if (
    typeof maxAttesa !== 'number' ||
    Number.isNaN(maxAttesa) ||
    maxAttesa < 0
  ) return null;

  const durate = trasferimenti.map(
    t => t?.durataMs
  );

  if (durate.some(t =>
    !Number.isSafeInteger(t) || t < 0
  )) return null;

  const minimo = finestre.map(f => f.minimo);
  const massimo = finestre.map(f => f.massimo);

  // Propagazione dei vincoli temporali.
  // Include anche il limite di attesa.

  for (let iter = 0; iter < gruppi.length; iter++) {

    verificaAttiva();

    let cambiato = false;

    for (let i = 1; i < gruppi.length; i++) {

      verificaAttiva();

      const offset =
        finestre[i - 1].durataMs +
        durate[i - 1];

      const nuovoMinimo = Math.max(
        minimo[i],
        minimo[i - 1] + offset
      );

      const nuovoMassimo = Math.min(
        massimo[i - 1],
        massimo[i] - offset
      );

      if (nuovoMinimo !== minimo[i]) {
        minimo[i] = nuovoMinimo;
        cambiato = true;
      }

      if (nuovoMassimo !== massimo[i - 1]) {
        massimo[i - 1] = nuovoMassimo;
        cambiato = true;
      }

      if (Number.isFinite(maxAttesa)) {

        const minPrecedente = Math.max(
          minimo[i - 1],
          minimo[i] - offset - maxAttesa
        );

        const maxSuccessivo = Math.min(
          massimo[i],
          massimo[i - 1] + offset + maxAttesa
        );

        if (minPrecedente !== minimo[i - 1]) {
          minimo[i - 1] = minPrecedente;
          cambiato = true;
        }

        if (maxSuccessivo !== massimo[i]) {
          massimo[i] = maxSuccessivo;
          cambiato = true;
        }
      }

      if (
        minimo[i] > massimo[i] ||
        minimo[i - 1] > massimo[i - 1]
      ) return null;
    }

    if (!cambiato) break;
  }

  const risultato = [];

  let attesaMs = 0;

  for (let i = 0; i < gruppi.length; i++) {

    verificaAttiva();

    let inizio = minimo[i];

    if (i > 0) {

      const arrivo =
        ms(risultato[i - 1].fine) +
        durate[i - 1];

      inizio = Math.max(inizio, arrivo);

      const attesa = inizio - arrivo;

      if (attesa > maxAttesa) return null;

      attesaMs += attesa;
    }

    if (inizio > massimo[i]) return null;

    const servizio = traslaServizioNcc(
      gruppi[i],
      inizio,
      { verificaAttiva }
    );

    if (!servizio) return null;

    risultato.push(servizio);
  }

  verificaAttiva();

  return {
    versione: '2.7.2',
    gruppi: risultato,
    attesaMs,
    inizio: risultato[0].inizio,
    fine: risultato.at(-1).fine,
    serviziPosticipati: risultato.filter(
      p => p.schedulazioneTemporale.posticipoMs > 0
    ).length,
    approvabile: false
  };
}