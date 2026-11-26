export const NCC_PARTIZIONI_VERSION = '2.8.1';

export function generaPartizioniNcc({
  prenotazioni,
  veicoli,
  maxPrenotazioni = 8,
  maxPartizioni = 500,
  verificaAttiva = () => {}
}) {
  if (!Array.isArray(prenotazioni) ||
      !Array.isArray(veicoli)) {
    throw new Error('NCC_INPUT_PARTIZIONI_INVALIDO');
  }

  if (!Number.isSafeInteger(maxPartizioni) ||
      maxPartizioni < 1 ||
      !Number.isSafeInteger(maxPrenotazioni) ||
      maxPrenotazioni < 1 ||
      maxPrenotazioni > 10) {
    throw new Error('NCC_LIMITI_PARTIZIONI_INVALIDI');
  }

  const rows = prenotazioni.map(p => ({
    id: String(p.id ?? ''),
    passeggeri: Number(p.passeggeri)
  }));

  if (rows.some(p =>
    !p.id ||
    !Number.isSafeInteger(p.passeggeri) ||
    p.passeggeri < 1
  )) {
    throw new Error('NCC_PRENOTAZIONE_INVALIDA');
  }

  if (new Set(rows.map(p => p.id)).size !== rows.length) {
    throw new Error('NCC_PRENOTAZIONI_DUPLICATE');
  }

  const flotta = veicoli.map(v => ({
    id: String(v.id ?? ''),
    posti: Number(v.posti_totali)
  }));

  if (flotta.some(v =>
    !v.id ||
    !Number.isSafeInteger(v.posti) ||
    v.posti < 1
  )) {
    throw new Error('NCC_VEICOLO_INVALIDO');
  }

  const report = {
    versione: NCC_PARTIZIONI_VERSION,
    modalita: 'SOLO_GENERAZIONE',
    prenotazioni: rows.map(p => p.id),
    passeggeri: rows.reduce(
      (s, p) => s + p.passeggeri, 0
    ),
    partizioni: [],
    nodiEsplorati: 0,
    limiteRaggiunto: false,
    stato: 'COMPLETATO'
  };

  if (!rows.length) {
    report.stato = 'NESSUNA_PRENOTAZIONE';
    return report;
  }

  if (rows.length > maxPrenotazioni) {
    report.stato = 'LIMITE_DIMENSIONE';
    report.limiteRaggiunto = true;
    return report;
  }

  const capienzaMassima = Math.max(
    0, ...flotta.map(v => v.posti)
  );

  if (rows.some(p => p.passeggeri > capienzaMassima)) {
    report.stato = 'CAPACITA_INSUFFICIENTE';
    return report;
  }

  const gruppi = [];

  function esplora(indice) {
    verificaAttiva();

    report.nodiEsplorati++;

    if (indice === rows.length) {
      if (report.partizioni.length >= maxPartizioni) {
        report.limiteRaggiunto = true;
        return;
      }

      const sottogruppi = gruppi.map(g => ({
        prenotazioni: g.rows.map(p => p.id),
        passeggeri: g.passeggeri,
        veicoliCompatibili: flotta
          .filter(v => v.posti >= g.passeggeri)
          .map(v => v.id)
      }));

      report.partizioni.push({
        originale: sottogruppi.length === 1,
        numeroGruppi: sottogruppi.length,
        sottogruppi
      });

      return;
    }

    const p = rows[indice];

    // Inserimento nei gruppi esistenti.
    for (const g of gruppi) {
      if (report.limiteRaggiunto) return;

      if (
        g.passeggeri + p.passeggeri >
        capienzaMassima
      ) continue;

      g.rows.push(p);
      g.passeggeri += p.passeggeri;

      esplora(indice + 1);

      g.rows.pop();
      g.passeggeri -= p.passeggeri;
    }

    if (report.limiteRaggiunto) return;

    // Creazione di un nuovo sottogruppo.
    gruppi.push({
      rows: [p],
      passeggeri: p.passeggeri
    });

    esplora(indice + 1);

    gruppi.pop();
  }

  esplora(0);

  report.partizioni.sort(
    (a, b) => a.numeroGruppi - b.numeroGruppi
  );

  report.totalePartizioni =
    report.partizioni.length;

  report.partizioniAlternative =
    report.partizioni.filter(p => !p.originale).length;

  if (report.limiteRaggiunto) {
    report.stato = 'LIMITE_PARTIZIONI';
  }

  return report;
}