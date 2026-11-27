// NCC_PARTIZIONI_COMPATIBILITA_V2902E2F1B2

import {
  restrizioniGruppoNcc,
  veicoliCompatibiliNcc
} from './ncc-compatibilita-veicoli.service.js';

import {
  aggregaPrenotazioniNcc
} from './ncc-aggregazione.service.js';

import {
  generaPartizioniNcc
} from './ncc-partizioni.service.js';

export const NCC_VALIDAZIONE_VERSION = '2.9.0';

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
    sottogruppiVeicoliIncompatibili: 0,
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
          id => {
            const row = rows.get(String(id));

            if (!row) {
              throw new Error(
                'NCC_PRENOTAZIONE_PARTIZIONE_INESISTENTE'
              );
            }

            return { ...row };
          }
        );

        const tipiVeicoloAmmessi =
          restrizioniGruppoNcc(subset);

        const minimoPasseggeri = Math.max(
          ...subset.map(r => Number(r.passeggeri))
        );

        const flottaCompatibile =
          veicoliCompatibiliNcc(
            veicoli,
            tipiVeicoloAmmessi,
            minimoPasseggeri
          );

        if (!flottaCompatibile.length) {
          const esito = {
            valido: false,
            motivo: 'NESSUN_VEICOLO_COMPATIBILE',
            dettaglio: {
              tipiVeicoloAmmessi,
              minimoPasseggeri
            }
          };

          cache.set(key, esito);

          report.sottogruppiVerificati++;
          report.sottogruppiRifiutati++;
          report.sottogruppiVeicoliIncompatibili++;

          rifiuti.push({
            chiave: key,
            motivo: esito.motivo,
            dettaglio: esito.dettaglio
          });

          continue;
        }

        const risultato =
          await aggregaPrenotazioniNcc(
            subset,
            routing,
            flottaCompatibile,
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
          const compatibili =
            veicoliCompatibiliNcc(
              flottaCompatibile,
              tipiVeicoloAmmessi,
              proposta.piccoPasseggeri
            ).map(v => String(v.id));

          if (!compatibili.length) {
            const esito = {
              valido: false,
              motivo: 'NESSUN_VEICOLO_COMPATIBILE',
              dettaglio: {
                tipiVeicoloAmmessi,
                piccoPasseggeri:
                  proposta.piccoPasseggeri
              }
            };

            cache.set(key, esito);

            report.sottogruppiRifiutati++;
            report.sottogruppiVeicoliIncompatibili++;

            rifiuti.push({
              chiave: key,
              motivo: esito.motivo,
              dettaglio: esito.dettaglio
            });

            continue;
          }

          const servizio = {
            chiave: key,
            ...proposta,
            tipiVeicoloAmmessi,
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