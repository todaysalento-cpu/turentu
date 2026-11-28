
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

  const comuneRipetuto = originale.match(/^(.+,\s*(?:\d{5}\s+)?([^,]+)),\s*(?:Italia|Italy),\s*([^,]+)$/i);
  const compatto = comuneRipetuto && pulisci(comuneRipetuto[2]).toLowerCase() === pulisci(comuneRipetuto[3]).toLowerCase()
    ? comuneRipetuto[1] + ', Italia' : originale;
  const senzaPaese = compatto.replace(/,\s*(?:Italia|Italy)$/i, '');
  const senzaProvincia = senzaPaese.replace(/(?:,\s*[A-Z]{2}|\s*\([A-Z]{2}\))$/, '');
  const standard = senzaProvincia !== originale
    ? senzaProvincia.match(/^(.+),\s*([^,]+)$/)
    : null;

  const indirizzoConComune = senzaProvincia.match(
    /^(.+),\s*((?:\d{5}\s+)?[\p{L}][\p{L} .\u2019\u0027-]*)$/iu
  );
  const localitaConRiferimento = /^(vicino|di fronte|davanti|presso|angolo|ang\.)\s/i;

  const aeroporto = senzaProvincia.match(
    /^(Aeroporto di .+?)\s*\(([A-Z]{3})\)\s*,\s*(.+)$/i
  );

  if (aeroporto) {
    comune = pulisci(aeroporto[3].split(',').at(-1)).replace(/^\d{5}\s+/, '');

    return {
      originale,
      comune,
      indirizzo: aeroporto[1],
      civico: null,
      puntoInteresse: aeroporto[1],
      codiceAeroporto: aeroporto[2].toUpperCase(),
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
  } else if (indirizzoConComune && !localitaConRiferimento.test(indirizzoConComune[2])) {
    comune = pulisci(indirizzoConComune[2]);
    indirizzo = pulisci(indirizzoConComune[1]);
  }

  if (comune) comune = comune.replace(/^\d{5}\s+/, '');

  indirizzo = indirizzo
    .replace(/^DA\s+/i, '')
    .replace(/^(\d+[a-z]?)\s+((?:via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\s+.+)$/i, '$2 $1')
    .replace(/\bP\.?\s*TTA\b/gi, 'Piazzetta')
    .replace(/,\s*(?=\d+[a-z]?(?:\/[a-z0-9]+)?(?:$|\s*[-–—]?\s+(?:vicino|di fronte|davanti|presso)\b))/i, ' ')
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

  const riferimentiCivico = [];
  const prefissoStradale = /^(?:via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\s/i;
  if (prefissoStradale.test(indirizzo)) {
    const conSuffisso = indirizzo.match(/^(.+?[ ,]\d+[a-z]?(?:\/[a-z0-9]+)?)(?:\s*[,–—-]\s*|\s+)(.+)$/i);
    if (conSuffisso) {
      const suffisso = pulisci(conSuffisso[2]);
      const chiave = testo => pulisci(testo).normalize('NFC').toLocaleLowerCase('it');
      const riferimentoAttivita = suffisso.match(/^(?:\(\s*([^()]+)\)?|((?:pasticceria|farmacia|pharmaservice)\b.+))$/i);
      if (comune && chiave(suffisso) === chiave(comune)) {
        indirizzo = conSuffisso[1];
      } else if (riferimentoAttivita && !prefissoStradale.test(riferimentoAttivita[1] ?? riferimentoAttivita[2])) {
        indirizzo = conSuffisso[1];
        riferimentiCivico.push(riferimentoAttivita[1] ?? riferimentoAttivita[2]);
      }
    }
    indirizzo = indirizzo.replace(/,\s*(?=\d+[a-z]?(?:\/[a-z0-9]+)?$)/i, ' ');
  }

  // Indirizzi alternativi o incroci.
  const secondoIndirizzo = indirizzo.match(
    /^(.+?)\s*(?:-|\/|\bANGOLO\b|\bANG\.)\s*((?:VIALE|VIA|PIAZZALE|PIAZZETTA|PIAZZA|CORSO|VICOLO|VICO|LARGO|CONTRADA|STRADA)\s+.+)$/i
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
    /^(.+?)\s*(?:-\s*)?\b(VICINO|DI FRONTE|DAVANTI|PRESSO|ANGOLO|ANG\.)(?:\s+(.+))?$/i
  );

  if (riferimento) {
    indirizzo = pulisci(riferimento[1]);
    note.push(
      [riferimento[2], riferimento[3]].filter(Boolean).join(' ')
    );
    ambiguo = true;
  }

  // Riferimento a una struttura separato da un trattino, anche senza spazi.
  const strutturaSeparata = indirizzo.match(
    /^((?:via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\s+.+?)\s*[-–—]\s*(.+)$/i
  );
  let riferimentoStradaleSeparato = false;
  if (strutturaSeparata &&
      /\b(?:boutique|hotel|albergo|masseria|residence|ristorante)\b/i.test(strutturaSeparata[2]) &&
      !/^(?:via|viale|piazza|piazzetta|piazzale|corso|vico|vicolo|largo|contrada|strada)\b/i.test(strutturaSeparata[2])) {
    riferimentoStradaleSeparato = !puntoInteresse;
    puntoInteresse ??= pulisci(strutturaSeparata[2]);
    indirizzo = pulisci(strutturaSeparata[1]);
  }

  // Nome struttura dopo un indirizzo.
  const struttura = indirizzo.match(
    /^(.+?)\s+\b(MASSERIA|HOTEL|ALBERGO|RESIDENCE|VILLA|CONSERVATORIO|RISTORANTE|STAZIONE|TERMINAL|OSPEDALE|BASILICA|CHIESA|FORO BOARIO|B&B)\b(.*)$/i
  );

if (
  struttura &&
  /^(VIALE|VIA|PIAZZALE|PIAZZETTA|PIAZZA|CORSO|VICOLO|VICO|LARGO|CONTRADA|STRADA)\b/i
    .test(indirizzo)
) {
  puntoInteresse ??= pulisci(
    `${struttura[2]}${struttura[3]}`
  );

  indirizzo = pulisci(struttura[1]);
}
  // Nome struttura prima dell'indirizzo.
  const strutturaIniziale = indirizzo.match(
    /^((?:[\p{L}\d.\u0027-]+\s+){0,3}(?:MASSERIA|HOTEL|ALBERGO|RESIDENCE|VILLA|CONSERVATORIO|RISTORANTE|OSPEDALE|B&B)\b.*?)\s+((?:VIALE|VIA|PIAZZALE|PIAZZETTA|PIAZZA|CORSO|CONTRADA|STRADA)\s+.+)$/iu
  );

  if (strutturaIniziale) {
    puntoInteresse ??= pulisci(
      strutturaIniziale[1]
    );

    indirizzo = pulisci(
      strutturaIniziale[2]
    );
  }

  // Elimina il comune ripetuto dopo un CAP, conservando il civico.
  const codaPostale = indirizzo.match(/^(.+?)[,\s]+(\d{5})[,\s]+([^,]+)[,\s]*$/);
  const cap = codaPostale && comune &&
    pulisci(codaPostale[3]).toLocaleLowerCase('it') === comune.toLocaleLowerCase('it') &&
    /\s\d+[a-z]?(?:\/[a-z0-9]+)?\s*$/i.test(codaPostale[1])
    ? codaPostale[2] : null;
  if (cap) indirizzo = codaPostale[1].trim();

  const stradale =
    /^(VIALE|VIA|PIAZZALE|PIAZZETTA|PIAZZA|CORSO|VICOLO|VICO|LARGO|CONTRADA|STRADA)\b/i
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
    ? componi(indirizzo, cap ? cap + ' ' + comune : comune)
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
    riferimentoStradaleSeparato,
    ambiguo,
    alternative,
    note: [...note, ...riferimentiCivico],
    normalizzato,
    queryPlaces
  };
}

export function normalizzaIndirizzoNcc(value) {
  if (typeof value !== 'string') return value;

  return analizzaIndirizzoNcc(value).normalizzato;
}
