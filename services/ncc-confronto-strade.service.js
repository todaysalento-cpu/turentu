
const TIPI = {
  via: 'via',
  viale: 'viale',
  piazza: 'piazza',
  piazzetta: 'piazzetta',
  piazzale: 'piazzale',
  corso: 'corso',
  largo: 'largo',
  vicolo: 'vicolo',
  vico: 'vico',
  contrada: 'contrada',
  strada: 'strada'
};

const ARTICOLI = new Set([
  'di', 'del', 'dello', 'della',
  'dei', 'degli', 'delle',
  'da', 'dal', 'dalla',
  'il', 'lo', 'la', 'le', 'i', 'gli'
]);

function analizza(value) {
  const parole = String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const tipo = TIPI[parole[0]] ?? null;

  if (tipo) parole.shift();

  return {
    tipo,
    parole: parole.filter(
      p => !ARTICOLI.has(p)
    )
  };
}

function risultato(compatibile, motivo) {
  return { compatibile, motivo };
}

export function confrontaStradeNcc(a, b) {
  const x = analizza(a);
  const y = analizza(b);

  if (!x.tipo || !y.tipo || x.tipo !== y.tipo) {
    return risultato(false, 'TIPO_STRADA_DIVERSO');
  }

  if (!x.parole.length || !y.parole.length) {
    return risultato(false, 'NOME_MANCANTE');
  }

  if (x.parole.join(' ') === y.parole.join(' ')) {
    return risultato(true, 'NOME_NORMALIZZATO');
  }

  if ([...x.parole, ...y.parole].every(parola => /^\p{L}+$/u.test(parola)) &&
    x.parole.join('') === y.parole.join('')) {
    return risultato(true, 'SPAZI_EQUIVALENTI');
  }

  const ultimoX = x.parole.at(-1);
  const ultimoY = y.parole.at(-1);

  if (ultimoX !== ultimoY || ultimoX.length < 3) {
    return risultato(false, 'NOME_DIFFERENTE');
  }

  if (
    [...x.parole, ...y.parole].some(
      p => /\d/.test(p) || /^(?:[ivxlcdm]{2,}|[ivx])$/i.test(p)
    )
  ) {
    return risultato(false, 'DENOMINAZIONE_NUMERICA');
  }

  if (
    x.parole.length === 1 &&
    y.parole.length === 2 ||
    y.parole.length === 1 &&
    x.parole.length === 2
  ) {
    return risultato(true, 'NOME_PROPRIO_OMESSO');
  }

  if (x.parole.length === y.parole.length) {
    const compatibili = x.parole.every(
      (p, i) => {
        const q = y.parole[i];

        return p === q ||
          (p.length === 1 && q.startsWith(p)) ||
          (q.length === 1 && p.startsWith(q));
      }
    );

    if (compatibili) {
      return risultato(true, 'INIZIALI_COMPATIBILI');
    }
  }

  return risultato(false, 'NOME_NON_EQUIVALENTE');
}
