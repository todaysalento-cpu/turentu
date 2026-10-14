// ============================================================
// TURENTU POPBUS V2 — CYCLE PRICING (MODULO PURO)
// Salvare come: services/popbus/v2/cycle-pricing.js
// Nessuna query DB, nessuna attivazione, nessun effetto collaterale.
// Importi monetari in EUR; calcoli e confronti in centesimi interi.
// ============================================================

export const COMMISSIONE_TURENTU_BPS = 1500; // 15% (basis points)

function assertFiniteNonNegative(value, label) {
  if (value === null || value === undefined || value === '' ||
      !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new TypeError(`${label}: numero finito non negativo obbligatorio`);
  }
  return Number(value);
}

function assertBps(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 10000) {
    throw new RangeError(`${label}: intero tra 0 e 9999`);
  }
  return value;
}

function toCents(value, label) {
  const n = assertFiniteNonNegative(value, label);
  const scaled = n * 100;
  if (!Number.isSafeInteger(Math.round(scaled))) {
    throw new RangeError(`${label}: importo fuori intervallo sicuro`);
  }
  return Math.round(scaled);
}

function ceilCents(value, label) {
  const n = assertFiniteNonNegative(value, label);
  const scaled = n * 100;
  if (!Number.isSafeInteger(Math.ceil(scaled - 1e-9))) {
    throw new RangeError(`${label}: importo fuori intervallo sicuro`);
  }
  return Math.ceil(scaled - 1e-9);
}

function safeSum(values, label) {
  const sum = values.reduce((acc, n) => acc + n, 0);
  if (!Number.isSafeInteger(sum)) throw new RangeError(`${label}: somma fuori intervallo sicuro`);
  return sum;
}

/**
 * Calcola il prezzo minimo lordo per coprire un costo netto, dopo la
 * commissione, con la condizione esatta sui centesimi:
 * gross - round(gross * commissionBps / 10000) >= cost.
 * Non si basa su arrotondamenti approssimativi di cost / 0.85.
 */
export function minimoLordoPerCostoCentesimi(costCents, commissionBps = COMMISSIONE_TURENTU_BPS) {
  if (!Number.isSafeInteger(costCents) || costCents < 0) {
    throw new RangeError('costCents: intero non negativo obbligatorio');
  }
  assertBps(commissionBps, 'commissionBps');
  if (costCents === 0) return 0;
  let low = costCents;
  let high = Math.ceil((costCents + 1) * 10000 / (10000 - commissionBps)) + 1;
  if (!Number.isSafeInteger(high)) throw new RangeError('Soglia fuori intervallo sicuro');
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const net = mid - Math.round(mid * commissionBps / 10000);
    if (net >= costCents) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Valutazione economica di un ciclo completo.
 *
 * @param {object} input
 * @param {number[]} input.ricaviRichiesteEuro - prezzo TOTALE di ciascuna richiesta
 * @param {number} input.kmAvvicinamento - dalla base alla prima missione
 * @param {number} input.kmMissioni - somma km commerciali delle missioni
 * @param {number} input.kmTrasferimenti - collegamenti a vuoto tra missioni
 * @param {number} input.kmRitornoBase - dall'ultima missione alla base
 * @param {number} input.euroKm - costo chilometrico del veicolo
 * @param {number} input.oreAttesa - attesa tra missioni
 * @param {number} input.costoAttesaOraEuro - costo orario di attesa
 * @param {number} input.altriCostiEuro - eventuali costi ulteriori espliciti
 * @param {number} input.commissionBps - default 1500 (15%)
 * @param {number} input.margineMinimoEuro - margine minimo aggiuntivo richiesto
 *
 * ATTENZIONE: le soglie commerciali per classe EXPRESS/STANDARD/SAVER
 * devono essere verificate separatamente dal chiamante. Questa funzione
 * certifica soltanto la copertura economica netta del ciclo completo.
 * Il ritorno non è facoltativo: fornire 0 SOLO se realmente pari a zero.
 */
export function valutaEconomiaCiclo(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input obbligatorio');
  const ricavi = input.ricaviRichiesteEuro;
  if (!Array.isArray(ricavi) || ricavi.length === 0) {
    throw new TypeError('ricaviRichiesteEuro: array non vuoto obbligatorio');
  }
  const ricaviCents = ricavi.map((v, i) => toCents(v, `ricaviRichiesteEuro[${i}]`));
  const ricavoLordoCents = safeSum(ricaviCents, 'ricavi');
  const commissionBps = assertBps(input.commissionBps ?? COMMISSIONE_TURENTU_BPS, 'commissionBps');

  // Tutte le componenti sono esplicite: non confondere km tecnici e commerciali.
  const kmAvvicinamento = assertFiniteNonNegative(input.kmAvvicinamento, 'kmAvvicinamento');
  const kmMissioni = assertFiniteNonNegative(input.kmMissioni, 'kmMissioni');
  const kmTrasferimenti = assertFiniteNonNegative(input.kmTrasferimenti, 'kmTrasferimenti');
  const kmRitornoBase = assertFiniteNonNegative(input.kmRitornoBase, 'kmRitornoBase');
  const euroKm = assertFiniteNonNegative(input.euroKm, 'euroKm');
  const oreAttesa = assertFiniteNonNegative(input.oreAttesa ?? 0, 'oreAttesa');
  const costoAttesaOraEuro = assertFiniteNonNegative(input.costoAttesaOraEuro ?? 0, 'costoAttesaOraEuro');
  const altriCostiCents = toCents(input.altriCostiEuro ?? 0, 'altriCostiEuro');
  const margineMinimoCents = toCents(input.margineMinimoEuro ?? 0, 'margineMinimoEuro');

  const kmTotali = kmAvvicinamento + kmMissioni + kmTrasferimenti + kmRitornoBase;
  if (!Number.isFinite(kmTotali)) throw new RangeError('kmTotali non valido');
  const costoKmCents = ceilCents(kmTotali * euroKm, 'costo chilometrico');
  const costoAttesaCents = toCents(oreAttesa * costoAttesaOraEuro, 'costo attesa');
  const costoCompletoCents = safeSum([costoKmCents, costoAttesaCents, altriCostiCents], 'costo completo');
  const commissioneCents = Math.round(ricavoLordoCents * commissionBps / 10000);
  const ricavoNettoCents = ricavoLordoCents - commissioneCents;
  const margineCents = ricavoNettoCents - costoCompletoCents;
  const sogliaLordoCents = minimoLordoPerCostoCentesimi(
    safeSum([costoCompletoCents, margineMinimoCents], 'costo + margine minimo'),
    commissionBps
  );

  return {
    commissionBps,
    km: { avvicinamento: kmAvvicinamento, missioni: kmMissioni,
      trasferimenti: kmTrasferimenti, ritornoBase: kmRitornoBase, totali: kmTotali },
    ricavoLordoEuro: ricavoLordoCents / 100,
    commissioneTurentuEuro: commissioneCents / 100,
    ricavoNettoEuro: ricavoNettoCents / 100,
    costoKmEuro: costoKmCents / 100,
    costoAttesaEuro: costoAttesaCents / 100,
    altriCostiEuro: altriCostiCents / 100,
    costoCompletoEuro: costoCompletoCents / 100,
    margineEuro: margineCents / 100,
    margineMinimoEuro: margineMinimoCents / 100,
    sogliaAttivazioneLordaEuro: sogliaLordoCents / 100,
    economicamenteAttivabile: margineCents >= margineMinimoCents,
    // Utili per controlli e persistenza esatti senza floating point.
    centesimi: { ricavoLordo: ricavoLordoCents, commissione: commissioneCents,
      ricavoNetto: ricavoNettoCents, costoKm: costoKmCents,
      costoAttesa: costoAttesaCents, altriCosti: altriCostiCents,
      costoCompleto: costoCompletoCents, margine: margineCents,
      sogliaLorda: sogliaLordoCents }
  };
}
