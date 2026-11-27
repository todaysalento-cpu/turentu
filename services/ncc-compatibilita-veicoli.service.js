
/**
 * NCC_COMPATIBILITA_VEICOLI_V2902E2C
 *
 * NULL: nessuna restrizione.
 * []: nessun veicolo ammesso.
 * Array: categorie esplicitamente ammesse.
 */

export const TIPI_VEICOLO_NCC = Object.freeze([
  'auto',
  'berlina',
  'suv',
  'van',
  'minivan',
  'minibus',
  'bus'
]);

const TIPI_NOTI = new Set(TIPI_VEICOLO_NCC);

export function normalizzaTipoVeicoloNcc(tipo) {
  if (typeof tipo !== 'string') {
    return null;
  }

  const valore = tipo.trim().toLowerCase();

  return TIPI_NOTI.has(valore)
    ? valore
    : null;
}

export function normalizzaRestrizioniNcc(tipi) {
  if (tipi === null) {
    return null;
  }

  // Dato malformato o mancante:
  // nessuna autorizzazione implicita.
  if (!Array.isArray(tipi)) {
    return [];
  }

  return [...new Set(
    tipi
      .map(normalizzaTipoVeicoloNcc)
      .filter(tipo => tipo !== null)
  )].sort();
}

export function intersecaRestrizioniNcc(
  ...restrizioni
) {
  let risultato = null;

  for (const restrizione of restrizioni) {
    const tipi =
      normalizzaRestrizioniNcc(restrizione);

    if (tipi === null) {
      continue;
    }

    risultato = risultato === null
      ? [...tipi]
      : risultato.filter(
          tipo => tipi.includes(tipo)
        );
  }

  return risultato;
}

export function veicoloCompatibileNcc(
  veicolo,
  restrizioni = null
) {
  if (!veicolo) {
    return false;
  }

  const tipi =
    normalizzaRestrizioniNcc(restrizioni);

  if (tipi === null) {
    return true;
  }

  const tipo =
    normalizzaTipoVeicoloNcc(veicolo.tipo);

  return tipo !== null &&
    tipi.includes(tipo);
}

export function restrizioniPrenotazioneNcc(row) {
  return intersecaRestrizioniNcc(
    row.origineTipiVeicoloAmmessi === undefined
      ? null
      : row.origineTipiVeicoloAmmessi,

    row.destinazioneTipiVeicoloAmmessi === undefined
      ? null
      : row.destinazioneTipiVeicoloAmmessi
  );
}

export function restrizioniGruppoNcc(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return [];
  }

  return intersecaRestrizioniNcc(
    ...rows.map(restrizioniPrenotazioneNcc)
  );
}

export function veicoliCompatibiliNcc(
  veicoli,
  restrizioni = null,
  passeggeri = 0
) {
  const richiesti = Number(passeggeri);

  if (
    !Number.isSafeInteger(richiesti) ||
    richiesti < 0
  ) {
    return [];
  }

  return veicoli.filter(v =>
    Number.isSafeInteger(Number(v.posti_totali)) &&
    Number(v.posti_totali) > 0 &&
    Number(v.posti_totali) >= richiesti &&
    veicoloCompatibileNcc(v, restrizioni)
  );
}
