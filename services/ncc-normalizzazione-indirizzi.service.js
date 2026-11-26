
function pulisci(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function componi(indirizzo, comune) {
  return [indirizzo, comune, 'Italia']
    .filter(Boolean)
    .join(', ');
}

export function analizzaIndirizzoNcc(value) {
  const originale = pulisci(value);

  let comune = null;
  let indirizzo = originale;

  const completo = originale.match(
    /^(.+?)\s+-\s+(.+?)\s+\/\s+(.+?)\s+-\s+(.+)$/
  );

  const semplice = originale.match(
    /^([\p{L} .'-]+?)\s+-\s+(.+)$/u
  );

  const standard = originale.match(
    /^(.+),\s*([^,]+),\s*Italia$/i
  );

  const aeroporto = originale.match(
    /^(Aeroporto di .+?)\s*\(([A-Z]{3})\)\s*,\s*(.+)$/i
  );

  if (aeroporto) {
    comune = pulisci(aeroporto[3]);

    return {
      originale,
      comune,
      indirizzo: aeroporto[1],
      civico: null,
      puntoInteresse: aeroporto[1],
      codiceAeroporto: aeroporto[2],
      ambiguo: false,
      alternative: [],
      note: [],
      normalizzato: componi(aeroporto[1], null),
      queryPlaces: componi(aeroporto[1], comune)
    };
  }

  if (completo) {
    comune = pulisci(completo[3]);
    indirizzo = pulisci(completo[4]);
  } else if (semplice) {
    comune = pulisci(semplice[1]);
    indirizzo = pulisci(semplice[2]);
  } else if (standard) {
    comune = pulisci(standard[2]);
    indirizzo = pulisci(standard[1]);
  }

  indirizzo = indirizzo
    .replace(/^DA\s+/i, '')
    .replace(/\bP\.?\s*ZZA\b/gi, 'Piazza')
    .replace(/\bP\.?\s*LE\b/gi, 'Piazzale')
    .replace(/\bV\.?\s*LE\b/gi, 'Viale');

  const note = [];
  const alternative = [];

  let puntoInteresse = null;
  let civico = null;
  let ambiguo = false;

  const parentesi = [
    ...indirizzo.matchAll(/\(([^)]+)\)/g)
  ];

  for (const p of parentesi) {
    const testo = pulisci(p[1]);

    if (
      /^(masseria|hotel|albergo|residence|villa|conservatorio|ristorante|stazione|terminal|ospedale|basilica|chiesa|b&b)\b/i
        .test(testo)
    ) {
      puntoInteresse ??= testo;
    } else {
      note.push(testo);
    }
  }

  indirizzo = pulisci(
    indirizzo.replace(/\([^)]*\)/g, ' ')
  );

  // Indirizzi alternativi o incroci.
  const secondoIndirizzo = indirizzo.match(
    /^(.+?)\s*(?:-|\/|\bANGOLO\b|\bANG\.)\s*((?:VIALE|VIA|PIAZZALE|PIAZZA|CORSO|VICOLO|VICO|LARGO|CONTRADA|STRADA)\s+.+)$/i
  );

  if (secondoIndirizzo) {
    ambiguo = true;

    alternative.push(
      pulisci(secondoIndirizzo[1]),
      pulisci(secondoIndirizzo[2])
    );

    indirizzo = alternative[0];
  }

  const riferimento = indirizzo.match(
    /^(.+?)\s*(?:-\s*)?\b(VICINO|DI FRONTE|DAVANTI|PRESSO|ANGOLO|ANG\.)\s+(.+)$/i
  );

  if (riferimento) {
    indirizzo = pulisci(riferimento[1]);
    note.push(
      `${riferimento[2]} ${riferimento[3]}`
    );
    ambiguo = true;
  }

  // Nome struttura dopo un indirizzo.
  const struttura = indirizzo.match(
    /^(.+?)\s+\b(MASSERIA|HOTEL|ALBERGO|RESIDENCE|VILLA|CONSERVATORIO|RISTORANTE|STAZIONE|TERMINAL|OSPEDALE|BASILICA|CHIESA|FORO BOARIO|B&B)\b(.*)$/i
  );

if (
  struttura &&
  /^(VIALE|VIA|PIAZZALE|PIAZZA|CORSO|VICOLO|VICO|LARGO|CONTRADA|STRADA)\b/i
    .test(indirizzo)
) {
  puntoInteresse ??= pulisci(
    `${struttura[2]}${struttura[3]}`
  );

  indirizzo = pulisci(struttura[1]);
}
  // Nome struttura prima dell'indirizzo.
  const strutturaIniziale = indirizzo.match(
    /^((?:MASSERIA|HOTEL|ALBERGO|RESIDENCE|VILLA|CONSERVATORIO|RISTORANTE|OSPEDALE|B&B)\b.+?)\s+((?:VIALE|VIA|PIAZZALE|PIAZZA|CORSO|CONTRADA|STRADA)\s+.+)$/i
  );

  if (strutturaIniziale) {
    puntoInteresse ??= pulisci(
      strutturaIniziale[1]
    );

    indirizzo = pulisci(
      strutturaIniziale[2]
    );
  }

  const stradale =
    /^(VIALE|VIA|PIAZZALE|PIAZZA|CORSO|VICOLO|VICO|LARGO|CONTRADA|STRADA)\b/i
      .test(indirizzo);

  if (stradale) {
    civico = indirizzo.match(
      /(?:\s|,)(\d+[a-z]?(?:\/[a-z0-9]+)?)$/i
    )?.[1] ?? null;
  } else {
    puntoInteresse ??= indirizzo;
  }

  if (note.length || alternative.length) {
    ambiguo = true;
  }

  const normalizzato = comune
    ? componi(indirizzo, comune)
    : indirizzo;

  const queryPlaces = comune
    ? componi(
        puntoInteresse || indirizzo,
        comune
      )
    : puntoInteresse || indirizzo;

  return {
    originale,
    comune,
    indirizzo,
    civico,
    puntoInteresse,
    ambiguo,
    alternative,
    note,
    normalizzato,
    queryPlaces
  };
}

export function normalizzaIndirizzoNcc(value) {
  if (typeof value !== 'string') return value;

  return analizzaIndirizzoNcc(value).normalizzato;
}
