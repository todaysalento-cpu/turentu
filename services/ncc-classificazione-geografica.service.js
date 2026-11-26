
function chiave(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function similarita(a, b) {
  const x = new Set(
    chiave(a).split(' ').filter(Boolean)
  );

  const y = new Set(
    chiave(b).split(' ').filter(Boolean)
  );

  if (!x.size || !y.size) return 0;

  const comuni = [...x].filter(
    parola => y.has(parola)
  ).length;

  return comuni / Math.max(x.size, y.size);
}

export function classificaCandidatiNcc(
  candidati,
  analisi
) {
  const validi = [];
  const esclusi = [];
  const nonVerificabili = [];

  for (const candidato of candidati) {
    const territorio = candidato.territorio;

    if (
      territorio?.stato === 'FUORI_COMUNE' ||
      territorio?.stato === 'COORDINATE_NON_VALIDE'
    ) {
      esclusi.push({
        ...candidato,
        punteggio: 0,
        motivoEsclusione: territorio.stato
      });

      continue;
    }

    if (!territorio?.valido) {
      nonVerificabili.push({
        ...candidato,
        punteggio: 0,
        motivoVerifica:
          territorio?.stato ??
          'TERRITORIO_NON_VERIFICATO'
      });

      continue;
    }

    let punteggio = 20;
    const motivi = ['COMUNE_COHERENTE'];

    if (candidato.precisione === 'ROOFTOP') {
      punteggio += 15;
      motivi.push('PRECISIONE_ROOFTOP');
    } else if (candidato.precisione === 'RANGE_INTERPOLATED') {
      punteggio += 10;
      motivi.push('PRECISIONE_INTERPOLATA');
    }

    if (candidato.civicoCoerente) {
      punteggio += 20;
      motivi.push('CIVICO_COERENTE');
    }

    if (candidato.stradaCoerente) {
      punteggio += 20;
      motivi.push('STRADA_COERENTE');
    } else if (candidato.stradaCompatibile) {
      punteggio += 12;
      motivi.push('STRADA_COMPATIBILE');
    }

    if (candidato.partialMatch) {
      punteggio -= 15;
      motivi.push('CORRISPONDENZA_PARZIALE');
    }

    if (
      candidato.precisione === 'GEOMETRIC_CENTER' ||
      candidato.precisione === 'APPROXIMATE'
    ) {
      punteggio -= 15;
      motivi.push('PRECISIONE_RIDOTTA');
    }

    if (analisi.puntoInteresse) {
      const pertinenza = similarita(
        analisi.puntoInteresse,
        candidato.nome
      );

      punteggio += Math.round(
        pertinenza * 40
      );

      if (pertinenza >= 0.8) {
        motivi.push('NOME_STRUTTURA_COERENTE');
      } else if (pertinenza < 0.3) {
        punteggio -= 15;
        motivi.push('STRUTTURA_POCO_PERTINENTE');
      }
    }

    punteggio = Math.max(
      0,
      Math.min(100, punteggio)
    );

    validi.push({
      ...candidato,
      punteggio,
      motiviClassificazione: motivi,
      richiedeConferma: true
    });
  }

  validi.sort(
    (a, b) => b.punteggio - a.punteggio
  );

  const primo = validi[0] ?? null;
  const secondo = validi[1] ?? null;
  const parita = Boolean(primo && secondo && primo.punteggio - secondo.punteggio < 10);
  const indirizziAlternativi = Boolean(analisi.alternative?.length > 1);
  const strutturaConStrada = Boolean(analisi.puntoInteresse && analisi.civico);
  const suggerimentoSospeso = Boolean(analisi.ambiguo || parita || indirizziAlternativi || strutturaConStrada || !primo || primo.punteggio < 40);

  return {
    candidati: validi,
    esclusi,
    nonVerificabili,
    suggerimentoSospeso,
    suggerito: suggerimentoSospeso ? null : primo
  };
}
