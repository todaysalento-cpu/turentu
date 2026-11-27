
// NCC_VALIDAZIONE_MISSIONI_V2902E2E5

import {
  normalizzaRestrizioniNcc,
  restrizioniGruppoNcc,
  intersecaRestrizioniNcc,
  veicoloCompatibileNcc
} from './ncc-compatibilita-veicoli.service.js';

export function validaMissioniNcc({
  missioni,
  prenotazioni,
  veicoli,
  occupati = new Set(),
  verificaAttiva = () => {}
}) {
  function errore(codice, dettaglio = {}) {
    throw Object.assign(
      new Error('NCC_AUDIT_' + codice),
      {
        code: 'NCC_AUDIT_' + codice,
        dettaglio
      }
    );
  }

  verificaAttiva();

  if (
    !Array.isArray(missioni) ||
    !Array.isArray(prenotazioni) ||
    !Array.isArray(veicoli)
  ) {
    errore('INPUT_INVALIDO');
  }

  const originali = new Map(
    prenotazioni.map(p => [String(p.id), p])
  );

  const flotta = new Map(
    veicoli.map(v => [String(v.id), v])
  );

  if (originali.size !== prenotazioni.length) {
    errore('INPUT_DUPLICATO');
  }

  if (flotta.size !== veicoli.length) {
    errore('FLOTTA_DUPLICATA');
  }

  const assegnate = new Set();
  const gruppiPerVeicolo = new Map();

  // NCC_AUDIT_CARICO_REALE_V2902E2E5B

  const intervalliVeicoli = new Map();

  const giornoLocale = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome',
    dateStyle: 'short'
  });

  let fermateVerificate = 0;
  let piccoMassimoVerificato = 0;

  function verificaCarico(gruppo, righe, posti, veicoloId) {
    const fermate = gruppo.itinerario?.fermate;

    if (!Array.isArray(fermate) || !fermate.length) {
      errore('FERMATE_MANCANTI', { veicoloId });
    }

    const attese = new Map(
      righe.map(p => [String(p.id), Number(p.passeggeri)])
    );

    const saliti = new Set();
    const scesi = new Set();

    let carico = 0;
    let picco = 0;
    let precedente = Date.parse(gruppo.inizio);

    const fine = Date.parse(gruppo.fine);

    if (
      !Number.isFinite(precedente) ||
      !Number.isFinite(fine) ||
      fine <= precedente
    ) {
      errore('INTERVALLO_GRUPPO_INVALIDO', { veicoloId });
    }

    for (const fermata of fermate) {
      verificaAttiva();

      const orario = Date.parse(fermata.orario);

      if (
        !Number.isFinite(orario) ||
        orario < precedente ||
        orario > fine
      ) {
        errore('CRONOLOGIA_FERMATE_INVALIDA', { veicoloId });
      }

      precedente = orario;

      if (!['salita', 'discesa'].includes(fermata.tipo)) {
        errore('TIPO_FERMATA_INVALIDO', { veicoloId });
      }

      if (
        !Array.isArray(fermata.prenotazioni) ||
        !fermata.prenotazioni.length
      ) {
        errore('FERMATA_VUOTA', { veicoloId });
      }

      for (const id of fermata.prenotazioni) {
        const k = String(id);

        if (!attese.has(k)) {
          errore('PRENOTAZIONE_FERMATA_ESTRANEA', { id: k });
        }

        const pax = attese.get(k);

        if (fermata.tipo === 'salita') {
          if (saliti.has(k)) {
            errore('SALITA_DUPLICATA', { id: k });
          }

          saliti.add(k);
          carico += pax;
        } else {
          if (!saliti.has(k) || scesi.has(k)) {
            errore('DISCESA_INVALIDA', { id: k });
          }

          scesi.add(k);
          carico -= pax;
        }

        if (carico < 0 || carico > posti) {
          errore('CARICO_REALE_NON_AMMESSO', {
            veicoloId,
            carico,
            posti
          });
        }

        picco = Math.max(picco, carico);
      }

      if (
        fermata.passeggeriABordo == null ||
        Number(fermata.passeggeriABordo) !== carico
      ) {
        errore('CARICO_FERMATA_INCOERENTE', {
          veicoloId,
          atteso: carico,
          dichiarato: fermata.passeggeriABordo
        });
      }

      fermateVerificate++;
    }

    if (
      carico !== 0 ||
      saliti.size !== attese.size ||
      scesi.size !== attese.size
    ) {
      errore('SERVIZIO_INCOMPLETO', { veicoloId });
    }

    if (Number(gruppo.piccoPasseggeri) !== picco) {
      errore('PICCO_REALE_INCOERENTE', {
        veicoloId,
        atteso: picco,
        dichiarato: gruppo.piccoPasseggeri
      });
    }

    piccoMassimoVerificato = Math.max(
      piccoMassimoVerificato,
      picco
    );

    return picco;
  }

  let gruppiVerificati = 0;
  let gruppiConRestrizioni = 0;
  let missioniConRestrizioni = 0;

  function equivalenti(a, b) {
    return JSON.stringify(
      normalizzaRestrizioniNcc(a)
    ) === JSON.stringify(
      normalizzaRestrizioniNcc(b)
    );
  }

  for (const missione of missioni) {
    verificaAttiva();

    const veicoloId = String(missione.veicoloId);
    const veicolo = flotta.get(veicoloId);

    if (!veicolo) {
      errore('VEICOLO_INESISTENTE', {
        veicoloId
      });
    }

    if (
      occupati.has(
        missione.giorno + '/' + veicoloId
      )
    ) {
      errore('VEICOLO_OCCUPATO', {
        veicoloId,
        giorno: missione.giorno
      });
    }

    const posti = Number(veicolo.posti_totali);

    if (
      !Number.isSafeInteger(posti) ||
      posti <= 0
    ) {
      errore('CAPIENZA_VEICOLO_INVALIDA', {
        veicoloId
      });
    }

    if (
      !Array.isArray(missione.gruppi) ||
      !missione.gruppi.length
    ) {
      errore('MISSIONE_VUOTA', {
        veicoloId
      });
    }

    const restrizioniMissione = [];

    const partenza = Date.parse(
      missione.logistica?.partenzaBase
    );

    const arrivo = Date.parse(
      missione.logistica?.arrivoBase
    );

    if (
      !Number.isFinite(partenza) ||
      !Number.isFinite(arrivo) ||
      arrivo <= partenza
    ) {
      errore('INTERVALLO_MISSIONE_INVALIDO', { veicoloId });
    }

    const intervalli = intervalliVeicoli.get(veicoloId) ?? [];

    for (const i of intervalli) {
      if (partenza < i.arrivo && i.partenza < arrivo) {
        errore('MISSIONI_SOVRAPPOSTE', { veicoloId });
      }
    }

    intervalli.push({ partenza, arrivo });
    intervalliVeicoli.set(veicoloId, intervalli);

    let finePrecedente = partenza;
    let piccoMissione = 0;
    let totaleMissione = 0;

    for (const gruppo of missione.gruppi) {
      verificaAttiva();

      if (
        !Array.isArray(gruppo.prenotazioni) ||
        !gruppo.prenotazioni.length
      ) {
        errore('GRUPPO_VUOTO', {
          veicoloId
        });
      }

      if (
        String(gruppo.veicoloId) !== veicoloId
      ) {
        errore('VEICOLO_GRUPPO_INCOERENTE', {
          veicoloId,
          veicoloGruppo: gruppo.veicoloId
        });
      }

      const righe = [];

      for (const id of gruppo.prenotazioni) {
        const k = String(id);
        const originale = originali.get(k);

        if (!originale) {
          errore('PRENOTAZIONE_NON_AUTORIZZATA', {
            id: k
          });
        }

        if (assegnate.has(k)) {
          errore('PRENOTAZIONE_DUPLICATA', {
            id: k
          });
        }

        // Entrambi i vincoli devono essere presenti
        // nelle prenotazioni validate da V290.

        for (const campo of [
          'origineTipiVeicoloAmmessi',
          'destinazioneTipiVeicoloAmmessi'
        ]) {
          const valore = originale[campo];

          if (
            valore !== null &&
            !Array.isArray(valore)
          ) {
            errore('VINCOLO_ORIGINALE_INVALIDO', {
              id: k,
              campo
            });
          }
        }

        const passeggeri =
          Number(originale.passeggeri);

        if (
          !Number.isSafeInteger(passeggeri) ||
          passeggeri <= 0 ||
          passeggeri > posti
        ) {
          errore('CAPIENZA_PRENOTAZIONE', {
            id: k,
            veicoloId,
            passeggeri,
            posti
          });
        }

        assegnate.add(k);
        righe.push(originale);
      }

      // Ricalcolo indipendente dai dati originali.

      const restrizioni =
        restrizioniGruppoNcc(righe);

      if (
        !veicoloCompatibileNcc(
          veicolo,
          restrizioni
        )
      ) {
        errore('CATEGORIA_VEICOLO_INCOMPATIBILE', {
          veicoloId,
          tipo: veicolo.tipo,
          prenotazioni: gruppo.prenotazioni,
          tipiVeicoloAmmessi: restrizioni
        });
      }

      // Un campo mancante non deve diventare
      // implicitamente una restrizione libera.

      if (
        gruppo.tipiVeicoloAmmessi === undefined ||
        !equivalenti(
          gruppo.tipiVeicoloAmmessi,
          restrizioni
        )
      ) {
        errore('RESTRIZIONI_GRUPPO_ALTERATE', {
          veicoloId,
          prenotazioni: gruppo.prenotazioni,
          attese: restrizioni,
          ricevute: gruppo.tipiVeicoloAmmessi
        });
      }

      const picco =
        Number(gruppo.piccoPasseggeri);

      const massimoIndividuale = Math.max(
        ...righe.map(p => Number(p.passeggeri))
      );

      const totale = righe.reduce(
        (somma, p) =>
          somma + Number(p.passeggeri),
        0
      );

      if (
        !Number.isSafeInteger(picco) ||
        picco < massimoIndividuale ||
        picco > totale ||
        picco > posti
      ) {
        errore('PICCO_PASSEGGERI_INVALIDO', {
          veicoloId,
          picco,
          posti
        });
      }

      const inizioGruppo = Date.parse(gruppo.inizio);
      const fineGruppo = Date.parse(gruppo.fine);

      if (
        !Number.isFinite(inizioGruppo) ||
        !Number.isFinite(fineGruppo) ||
        inizioGruppo < finePrecedente ||
        fineGruppo <= inizioGruppo ||
        fineGruppo > arrivo
      ) {
        errore('CRONOLOGIA_GRUPPI_INVALIDA', { veicoloId });
      }

      if (
        giornoLocale.format(new Date(inizioGruppo)) !==
        missione.giorno
      ) {
        errore('GIORNO_MISSIONE_INCOERENTE', { veicoloId });
      }

      finePrecedente = fineGruppo;

      if (Number(gruppo.passeggeri) !== totale) {
        errore('TOTALE_GRUPPO_INCOERENTE', { veicoloId });
      }

      if (Number(gruppo.posti) !== posti) {
        errore('POSTI_GRUPPO_INCOERENTI', { veicoloId });
      }

      const piccoReale = verificaCarico(
        gruppo,
        righe,
        posti,
        veicoloId
      );

      piccoMissione = Math.max(piccoMissione, piccoReale);
      totaleMissione += totale;

      restrizioniMissione.push(restrizioni);

      if (restrizioni !== null) {
        gruppiConRestrizioni++;
      }

      gruppiVerificati++;
    }

    if (Number(missione.posti) !== posti) {
      errore('POSTI_MISSIONE_INCOERENTI', { veicoloId });
    }

    if (Number(missione.piccoPasseggeri) !== piccoMissione) {
      errore('PICCO_MISSIONE_INCOERENTE', { veicoloId });
    }

    if (Number(missione.passeggeri) !== totaleMissione) {
      errore('TOTALE_MISSIONE_INCOERENTE', { veicoloId });
    }

    const restrizioniComplessive =
      intersecaRestrizioniNcc(
        ...restrizioniMissione
      );

    if (
      !veicoloCompatibileNcc(
        veicolo,
        restrizioniComplessive
      )
    ) {
      errore('MISSIONE_INCOMPATIBILE', {
        veicoloId,
        tipiVeicoloAmmessi:
          restrizioniComplessive
      });
    }

    if (
      missione.tipiVeicoloAmmessi === undefined ||
      !equivalenti(
        missione.tipiVeicoloAmmessi,
        restrizioniComplessive
      )
    ) {
      errore('RESTRIZIONI_MISSIONE_ALTERATE', {
        veicoloId
      });
    }

    if (restrizioniComplessive !== null) {
      missioniConRestrizioni++;
    }

    gruppiPerVeicolo.set(
      veicoloId,
      (gruppiPerVeicolo.get(veicoloId) ?? 0) +
      missione.gruppi.length
    );
  }

  verificaAttiva();

  return {
    versione: 'V290.2E.2E.5B',
    valido: true,
    caricoRealeVerificato: true,
    capienzaVerificata: true,
    cronologiaFermateVerificata: true,
    sovrapposizioniMissioniVerificate: true,
    fermateVerificate,
    piccoMassimoVerificato,
    compatibilitaVeicoliVerificata: true,
    restrizioniOriginaliVerificate: true,
    univocitaPrenotazioniVerificata: true,
    missioniVerificate: missioni.length,
    gruppiVerificati,
    gruppiConRestrizioni,
    missioniConRestrizioni,
    prenotazioniVerificate: assegnate.size,
    veicoliUtilizzati: gruppiPerVeicolo.size
  };
}
