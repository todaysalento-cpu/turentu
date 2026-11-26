import {
  aggregaPrenotazioniNcc
} from './ncc-aggregazione.service.js';

import {
  generaPartizioniNcc
} from './ncc-partizioni.service.js';

export const NCC_VALIDAZIONE_VERSION = '2.8.2';

export async function validaPartizioniNcc({
  prenotazioni,
  veicoli,
  routing,
  parametri = {},
  riferimento = Date.now(),
  verificaAttiva = () => {},
  maxPrenotazioni = 8,
  maxPartizioni = 500,
  maxSottogruppi = 255
}) {
  verificaAttiva();

  if (!Number.isSafeInteger(maxSottogruppi) ||
      maxSottogruppi < 1) {
    throw new Error('NCC_LIMITE_SOTTOGRUPPI_INVALIDO');
  }

  const generazione = generaPartizioniNcc({
    prenotazioni,
    veicoli,
    maxPrenotazioni,
    maxPartizioni,
    verificaAttiva
  });

  const rows = new Map(
    prenotazioni.map(r => [String(r.id), r])
  );

  const firma = ids =>
    JSON.stringify(ids.map(String).sort());

  const cache = new Map();

  const report = {
    versione: NCC_VALIDAZIONE_VERSION,
    modalita: 'SOLO_VALIDAZIONE',
    stato: generazione.stato,
    partizioniGenerate: generazione.partizioni.length,
    sottogruppiVerificati: 0,
    sottogruppiValidi: 0,
    sottogruppiRifiutati: 0,
    cacheHit: 0,
    limiteRaggiunto: generazione.limiteRaggiunto,
    catalogo: [],
    partizioniValide: [],
    partizioniRifiutate: [],
    partizioniNonVerificate: []
  };

  for (const partizione of generazione.partizioni) {
    verificaAttiva();

    const chiavi = [];
    const rifiuti = [];
    const nonVerificati = [];

    for (const gruppo of partizione.sottogruppi) {
      verificaAttiva();

      const key = firma(gruppo.prenotazioni);

      chiavi.push(key);

      if (cache.has(key)) {
        report.cacheHit++;
      } else {
        if (
          report.sottogruppiVerificati >= maxSottogruppi
        ) {
          report.limiteRaggiunto = true;
          nonVerificati.push(key);
          continue;
        }

        const subset = gruppo.prenotazioni.map(
          id => ({ ...rows.get(String(id)) })
        );

        const risultato =
          await aggregaPrenotazioniNcc(
            subset,
            routing,
            veicoli,
            parametri,
            riferimento,
            {
              verificaAttiva,
              finestreTemporali: true
            }
          );

        verificaAttiva();

        report.sottogruppiVerificati++;

        const proposta = risultato.proposte[0];

        const valida =
          risultato.proposte.length === 1 &&
          risultato.nonAssegnate.length === 0 &&
          firma(proposta.prenotazioni) === key &&
          proposta.itinerario?.flessibilitaTemporale != null;

        if (valida) {
          const compatibili = veicoli
            .filter(v =>
              Number(v.posti_totali) >=
              proposta.piccoPasseggeri
            )
            .map(v => String(v.id));

          const servizio = {
            chiave: key,
            ...proposta,
            veicoliCompatibili: compatibili,
            approvabile: false
          };

          cache.set(key, {
            valido: true,
            servizio
          });

          report.catalogo.push(servizio);
          report.sottogruppiValidi++;
        } else {
          cache.set(key, {
            valido: false,
            motivo: 'SOTTOGRUPPO_NON_AGGREGABILE',
            dettaglio: risultato.nonAssegnate
          });

          report.sottogruppiRifiutati++;
        }
      }

      const esito = cache.get(key);

      if (!esito.valido) {
        rifiuti.push({
          chiave: key,
          motivo: esito.motivo,
          dettaglio: esito.dettaglio
        });
      }
    }

    const configurazione = {
      originale: partizione.originale,
      numeroGruppi: partizione.numeroGruppi,
      servizi: chiavi
    };

    if (nonVerificati.length) {
      report.partizioniNonVerificate.push({
        ...configurazione,
        nonVerificati
      });
    } else if (rifiuti.length) {
      report.partizioniRifiutate.push({
        ...configurazione,
        rifiuti
      });
    } else {
      report.partizioniValide.push(configurazione);
    }
  }

  if (report.limiteRaggiunto) {
    report.stato = 'VALIDAZIONE_PARZIALE';
  }

  verificaAttiva();

  return report;
}