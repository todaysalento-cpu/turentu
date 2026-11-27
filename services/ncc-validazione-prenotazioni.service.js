// NCC_VALIDAZIONE_COMPATIBILITA_V2902E2F1D2C
import assert from 'node:assert/strict';

import {
  creaAuditCompatibilitaCpsatNcc
} from './ncc-audit-compatibilita-cpsat.service.js';

import {
  NCC_V2_PARAMS
} from './ncc-aggregazione.service.js';

export const NCC_VALIDAZIONE_PRENOTAZIONI_VERSION =
  '2.9.0';

const MIN = 60000;
const EPS = 1e-6;

const key = value =>
  String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const firma = ids =>
  JSON.stringify(ids.map(String).sort());

function verifica(condizione, motivo, dettaglio = '') {
  assert.ok(
    condizione,
    'NCC_VALIDAZIONE_' + motivo +
      (dettaglio ? ': ' + dettaglio : '')
  );
}

export async function validaPrenotazioniCpsatNcc({
  catalogo,
  validazione,
  routing,
  prenotazioniOriginali,
  veicoliOriginali,
  verificaAttiva = () => {}
}) {

  verificaAttiva();

  verifica(
    validazione?.valida === true,
    'LOGISTICA_NON_VALIDATA'
  );

  const auditRigoroso =
    catalogo?.versione === '2.9.0' ||
    prenotazioniOriginali !== undefined ||
    veicoliOriginali !== undefined ||
    validazione.audit?.compatibilitaIndipendenteVerificata === true;

  const auditCompatibilita = auditRigoroso
    ? creaAuditCompatibilitaCpsatNcc({
        catalogo,
        prenotazioniOriginali,
        veicoliOriginali,
        verificaAttiva
      })
    : null;

  let serviziCompatibilitaPrenotazioniVerificata = 0;

  if (auditRigoroso) {
    verifica(
      validazione.audit?.compatibilitaIndipendenteVerificata === true &&
      validazione.audit?.datiOriginaliVerificati === true,
      'AUDIT_LOGISTICO_MANCANTE'
    );

    verifica(
      Array.isArray(validazione.serviziTraslati) &&
      validazione.audit.serviziCompatibilitaVerificata ===
        validazione.serviziTraslati.length,
      'AUDIT_LOGISTICO_INCOMPLETO'
    );
  }

  verifica(
    typeof routing?.tratta === 'function' &&
    typeof routing?.diagnostica === 'function',
    'ROUTING_INVALIDO'
  );

  const routingPrima = structuredClone(
    routing.diagnostica()
  );

  verifica(
    routingPrima.autorizzazioneRigorosa === true &&
    routingPrima.geocodingAutonomoConsentito === false,
    'ROUTING_NON_RIGOROSO'
  );

  verifica(
    !routingPrima.interrotta &&
    !routingPrima.budgetEsaurito,
    'ROUTING_NON_DISPONIBILE'
  );

  const p = {
    ...NCC_V2_PARAMS,
    tolleranzaMinuti: 20,
    ...catalogo.parametri
  };

  for (const nome of [
    'tolleranzaMinuti',
    'deviazioneMassima',
    'tempoAggiuntivoMinuti',
    'anticipoAeroportoMinuti',
    'durataFermataMinuti'
  ]) {
    verifica(
      Number.isFinite(p[nome]) &&
      p[nome] >= 0,
      'PARAMETRO_INVALIDO',
      nome
    );
  }

  verifica(
    Number.isSafeInteger(p.maxFermate) &&
    p.maxFermate >= 2,
    'MAX_FERMATE_INVALIDO'
  );

  for (const nome of [
    'multisalita',
    'multidiscesa',
    'serviziSingoli',
    'stessoVolo'
  ]) {
    verifica(
      typeof p[nome] === 'boolean',
      'PARAMETRO_INVALIDO',
      nome
    );
  }

  const rows = new Map(
    catalogo.prenotazioni.map(r => [
      String(r.id),
      r
    ])
  );

  const veicoli = new Map(
    catalogo.veicoli.map(v => [
      String(v.id),
      v
    ])
  );

  const servizi = new Map(
    catalogo.servizi.map(s => [
      String(s.id),
      s
    ])
  );

  verifica(
    rows.size === catalogo.prenotazioni.length,
    'PRENOTAZIONI_DUPLICATE'
  );

  verifica(
    veicoli.size === catalogo.veicoli.length,
    'VEICOLI_DUPLICATI'
  );

  verifica(
    servizi.size === catalogo.servizi.length,
    'SERVIZI_DUPLICATI'
  );

  const DAY =
    catalogo.durataGiornoMs ?? 86400000;

  const riferimento = catalogo.riferimento;

  verifica(
    Number.isSafeInteger(riferimento) &&
    [82800000, 86400000, 90000000].includes(DAY),
    'GIORNATA_INVALIDA'
  );

  const tratte = new Map();

  const validate = new Set();
  const serviziValidati = new Set();

  const dettaglio = [];

  const report = {
    serviziVerificati: 0,
    fermateVerificate: 0,
    prenotazioniVerificate: 0,
    passeggeriVerificati: 0,
    voliArrivoVerificati: 0,
    voliPartenzaVerificati: 0,
    prenotazioniSenzaVolo: 0,
    tratteUniche: 0,
    tratteRiutilizzate: 0,
    ricaviCompleti: true,
    ricaviCentesimi: 0
  };

  async function tratta(a, b) {

    verificaAttiva();

    const id = JSON.stringify([
      key(a),
      key(b)
    ]);

    if (tratte.has(id)) {
      report.tratteRiutilizzate++;
      return tratte.get(id);
    }

    const t = await routing.tratta(a, b);

    verificaAttiva();

    verifica(
      t &&
      Number.isFinite(t.distanzaKm) &&
      t.distanzaKm >= 0 &&
      Number.isSafeInteger(t.durataMs) &&
      t.durataMs >= 0,
      'TRATTA_NON_DISPONIBILE',
      a + ' -> ' + b
    );

    tratte.set(id, t);

    return t;
  }

  for (const elemento of validazione.serviziTraslati) {

    verificaAttiva();

    const servizioId = String(elemento.servizio);

    const c = servizi.get(servizioId);

    const v = veicoli.get(
      String(elemento.veicolo)
    );

    const proposta = elemento.proposta;

    verifica(
      c && v && proposta,
      'SERVIZIO_NON_RICONOSCIUTO'
    );

    if (auditCompatibilita) {
      auditCompatibilita.verificaServizio({
        servizio: c,
        veicoloId: v.id,
        proposta
      });

      serviziCompatibilitaPrenotazioniVerificata++;
    }

    verifica(
      !serviziValidati.has(servizioId),
      'SERVIZIO_DUPLICATO',
      servizioId
    );

    serviziValidati.add(servizioId);

    verifica(
      firma(proposta.prenotazioni) ===
      firma(c.prenotazioni),
      'IDENTITA_SERVIZIO',
      servizioId
    );

    const ids = c.prenotazioni.map(String);

    const idsServizio = new Set(ids);

    verifica(
      ids.length > 0 &&
      idsServizio.size === ids.length,
      'IDENTITA_PRENOTAZIONI',
      servizioId
    );

    const fermate =
      proposta.itinerario?.fermate;

    verifica(
      Array.isArray(fermate) &&
      fermate.length >= 2 &&
      fermate.length <= p.maxFermate,
      'NUMERO_FERMATE',
      servizioId
    );

    verifica(
      fermate[0].tipo === 'salita' &&
      fermate.at(-1).tipo === 'discesa',
      'ESTREMI_ITINERARIO',
      servizioId
    );

    verifica(
      Date.parse(fermate[0].orario) ===
      Date.parse(proposta.inizio) &&
      Date.parse(fermate.at(-1).orario) ===
      Date.parse(proposta.fine),
      'ORARI_ITINERARIO',
      servizioId
    );

    verifica(
      key(fermate[0].localita) ===
      key(c.origine) &&
      key(fermate.at(-1).localita) ===
      key(c.destinazione),
      'ESTREMI_LOCALITA',
      servizioId
    );

    const dati = new Map();

    let paxTotali = 0;
    let ricavi = 0;

    const origini = new Set();
    const destinazioni = new Set();

    for (const id of ids) {

      verificaAttiva();

      const row = rows.get(id);

      verifica(
        row && !validate.has(id),
        'PRENOTAZIONE_NON_VALIDA',
        id
      );

      verifica(
        typeof row.origine === 'string' &&
        row.origine.trim() &&
        typeof row.destinazione === 'string' &&
        row.destinazione.trim(),
        'LOCALITA_INVALIDA',
        id
      );

      const pax = Number(row.passeggeri);

      verifica(
        Number.isSafeInteger(pax) &&
        pax > 0 &&
        pax <= v.posti,
        'PASSEGGERI_INVALIDI',
        id
      );

      const pickup = Date.parse(row.prelievo_il);

      verifica(
        Number.isFinite(pickup),
        'PRELIEVO_INVALIDO',
        id
      );

      let earliest = Math.max(
        riferimento,
        pickup - p.tolleranzaMinuti * MIN
      );

      const latest =
        pickup + p.tolleranzaMinuti * MIN;

      let deadline = Infinity;

      const direzione = row.volo_direzione;

      const flight = Date.parse(
        row.volo_programmato_il
      );

      if (direzione === 'partenza') {

        verifica(
          Number.isFinite(flight),
          'VOLO_PARTENZA_INVALIDO',
          id
        );

        deadline =
          flight -
          p.anticipoAeroportoMinuti * MIN;

        report.voliPartenzaVerificati++;

      } else if (direzione === 'arrivo') {

        verifica(
          Number.isFinite(flight),
          'VOLO_ARRIVO_INVALIDO',
          id
        );

        earliest = Math.max(
          earliest,
          flight
        );

        report.voliArrivoVerificati++;

      } else {

        verifica(
          !direzione &&
          !row.volo_numero &&
          !row.volo_programmato_il &&
          !row.volo_orario,
          'DATI_VOLO_INCOMPLETI',
          id
        );

        report.prenotazioniSenzaVolo++;
      }

      verifica(
        earliest <= latest,
        'FINESTRA_PRELIEVO_IMPOSSIBILE',
        id
      );

      // NCC_CONTROLLO_PREVENTIVO_LOCALITA_V286E32

      const salitePrenotazione = fermate.filter(f =>
        f.tipo === 'salita' &&
        Array.isArray(f.prenotazioni) &&
        f.prenotazioni.map(String).includes(id)
      );

      const discesePrenotazione = fermate.filter(f =>
        f.tipo === 'discesa' &&
        Array.isArray(f.prenotazioni) &&
        f.prenotazioni.map(String).includes(id)
      );

      for (const salita of salitePrenotazione) {

        verifica(
          key(salita.localita) === key(row.origine),
          'ORIGINE_ERRATA',
          id
        );
      }

      for (const discesa of discesePrenotazione) {

        verifica(
          key(discesa.localita) === key(row.destinazione),
          'DESTINAZIONE_ERRATA',
          id
        );
      }

      const diretta = await tratta(
        row.origine,
        row.destinazione
      );

      dati.set(id, {
        row,
        pax,
        earliest,
        latest,
        deadline,
        diretta
      });

      paxTotali += pax;

      origini.add(key(row.origine));
      destinazioni.add(key(row.destinazione));

      if (row.prezzo_centesimi == null) {
        ricavi = null;
      } else {

        const prezzo =
          Number(row.prezzo_centesimi);

        verifica(
          Number.isSafeInteger(prezzo) &&
          prezzo >= 0,
          'PREZZO_INVALIDO',
          id
        );

        if (ricavi !== null) {
          ricavi += prezzo;
        }
      }
    }

    verifica(
      p.multisalita || origini.size === 1,
      'MULTISALITA_NON_CONSENTITA'
    );

    verifica(
      p.multidiscesa || destinazioni.size === 1,
      'MULTIDISCESA_NON_CONSENTITA'
    );

    verifica(
      p.serviziSingoli || ids.length > 1,
      'SERVIZIO_SINGOLO_NON_CONSENTITO'
    );

    if (p.stessoVolo && ids.length > 1) {

      const flights = ids.map(id => {

        const r = dati.get(id).row;

        return r.volo_numero
          ? JSON.stringify([
              r.volo_numero,
              r.volo_aeroporto,
              r.volo_direzione,
              Date.parse(r.volo_programmato_il)
            ])
          : null;
      });

      verifica(
        flights[0] &&
        flights.every(f => f === flights[0]),
        'VOLI_DIFFERENTI'
      );
    }

    const onboard = new Map();
    const completed = new Set();
    const fermateUsate = new Set();

    let carico = 0;
    let picco = 0;
    let km = 0;
    let precedente = null;

    for (const f of fermate) {

      verificaAttiva();

      verifica(
        ['salita', 'discesa'].includes(f.tipo),
        'TIPO_FERMATA'
      );

      verifica(
        typeof f.localita === 'string' &&
        f.localita.trim(),
        'LOCALITA_FERMATA'
      );

      const chiaveFermata =
        f.tipo + '|' + key(f.localita);

      verifica(
        !fermateUsate.has(chiaveFermata),
        'FERMATA_DUPLICATA'
      );

      fermateUsate.add(chiaveFermata);

      const orario = Date.parse(f.orario);

      verifica(
        Number.isSafeInteger(orario) &&
        orario >= riferimento &&
        orario < riferimento + DAY,
        'ORARIO_FERMATA'
      );

      verifica(
        Array.isArray(f.prenotazioni) &&
        f.prenotazioni.length > 0 &&
        new Set(
          f.prenotazioni.map(String)
        ).size === f.prenotazioni.length,
        'PRENOTAZIONI_FERMATA'
      );

      if (precedente) {

        const leg = await tratta(
          precedente.localita,
          f.localita
        );

        const minimoArrivo =
          precedente.orario +
          p.durataFermataMinuti * MIN +
          leg.durataMs;

        verifica(
          orario >= minimoArrivo,
          'TRASFERIMENTO_FERMATE_IMPOSSIBILE',
          servizioId
        );

        km += leg.distanzaKm;
      }

      verifica(
        Number.isFinite(f.kmProgressivi) &&
        Math.abs(f.kmProgressivi - km) <= EPS,
        'KM_PROGRESSIVI_INCOERENTI',
        servizioId
      );

      for (const rawId of f.prenotazioni) {

        const id = String(rawId);

        const r = dati.get(id);

        verifica(
          r && idsServizio.has(id),
          'PRENOTAZIONE_ESTRANEA',
          id
        );

        if (f.tipo === 'salita') {

          verifica(
            !onboard.has(id) &&
            !completed.has(id),
            'SALITA_DUPLICATA',
            id
          );

          verifica(
            key(f.localita) ===
            key(r.row.origine),
            'ORIGINE_ERRATA',
            id
          );

          verifica(
            Date.parse(f.prelievo) === orario,
            'ORARIO_SALITA_INCOERENTE',
            id
          );

          verifica(
            orario >= r.earliest &&
            orario <= r.latest,
            'PRELIEVO_FUORI_FINESTRA',
            id
          );

          onboard.set(id, {
            orario,
            partenza:
              orario +
              p.durataFermataMinuti * MIN,
            km
          });

          carico += r.pax;

        } else {

          const salita = onboard.get(id);

          verifica(
            salita && !completed.has(id),
            'DISCESA_SENZA_SALITA',
            id
          );

          verifica(
            key(f.localita) ===
            key(r.row.destinazione),
            'DESTINAZIONE_ERRATA',
            id
          );

          verifica(
            f.prelievo === null,
            'PRELIEVO_IN_DISCESA',
            id
          );

          verifica(
            orario <= r.deadline,
            'DEADLINE_VOLO',
            id
          );

          const rideKm = km - salita.km;

          const rideMs =
            orario - salita.partenza;

          verifica(
            rideKm >= -EPS &&
            rideMs >= 0,
            'PERCORRENZA_NEGATIVA',
            id
          );

          verifica(
            rideKm <=
              r.diretta.distanzaKm *
              (1 + p.deviazioneMassima) + EPS,
            'DEVIAZIONE_ECCESSIVA',
            id
          );

          verifica(
            rideMs <=
              r.diretta.durataMs +
              p.tempoAggiuntivoMinuti * MIN,
            'TEMPO_AGGIUNTIVO_ECCESSIVO',
            id
          );

          onboard.delete(id);
          completed.add(id);

          carico -= r.pax;

          dettaglio.push({
            prenotazione: id,
            servizio: servizioId,
            veicolo: String(v.id),
            passeggeri: r.pax,
            prelievo:
              new Date(salita.orario).toISOString(),
            discesa:
              new Date(orario).toISOString(),
            kmIndividuali: rideKm,
            kmDiretti: r.diretta.distanzaKm,
            durataViaggioMs: rideMs,
            durataDirettaMs: r.diretta.durataMs,
            voloDirezione:
              r.row.volo_direzione ?? null
          });
        }
      }

      verifica(
        carico >= 0 &&
        carico <= v.posti,
        'CAPIENZA_SUPERATA',
        servizioId
      );

      verifica(
        f.passeggeriABordo === carico,
        'CARICO_DICHIARATO_INCOERENTE',
        servizioId
      );

      picco = Math.max(picco, carico);

      precedente = {
        localita: f.localita,
        orario
      };

      report.fermateVerificate++;
    }

    verifica(
      onboard.size === 0 &&
      carico === 0 &&
      completed.size === ids.length,
      'PRENOTAZIONI_NON_COMPLETATE',
      servizioId
    );

    verifica(
      picco === c.piccoPasseggeri &&
      picco === proposta.piccoPasseggeri &&
      picco === proposta.itinerario.piccoPasseggeri,
      'PICCO_INCOERENTE',
      servizioId
    );

    verifica(
      paxTotali === c.passeggeri &&
      paxTotali === proposta.passeggeri,
      'PASSEGGERI_TOTALI_INCOERENTI',
      servizioId
    );

    verifica(
      Math.round(km * 1000) === c.distanzaMetri &&
      Math.abs(
        km - proposta.itinerario.km
      ) <= EPS,
      'DISTANZA_SERVIZIO_INCOERENTE',
      servizioId
    );

    verifica(
      ricavi === c.ricaviCentesimi &&
      ricavi === proposta.economia.ricaviCentesimi,
      'RICAVI_INCOERENTI',
      servizioId
    );

    if (ricavi === null) {
      report.ricaviCompleti = false;
    } else {
      report.ricaviCentesimi += ricavi;
    }

    for (const id of completed) {
      validate.add(id);
    }

    report.serviziVerificati++;
    report.prenotazioniVerificate += ids.length;
    report.passeggeriVerificati += paxTotali;
  }

  verifica(
    firma([...validate]) ===
    firma(validazione.prenotazioniAssegnate),
    'COPERTURA_INCOERENTE'
  );

  verifica(
    report.ricaviCompleti
      ? report.ricaviCentesimi / 100 ===
          validazione.ricavi
      : validazione.ricavi === null,
    'RICAVI_COMPLESSIVI_INCOERENTI'
  );

  verificaAttiva();

  const routingDopo = structuredClone(
    routing.diagnostica()
  );

  verifica(
    !routingDopo.interrotta &&
    !routingDopo.budgetEsaurito,
    'ROUTING_NON_COMPLETATO'
  );

  report.tratteUniche = tratte.size;

  if (!report.ricaviCompleti) {
    report.ricaviCentesimi = null;
  }

  if (auditCompatibilita) {
    verifica(
      serviziCompatibilitaPrenotazioniVerificata ===
        validazione.serviziTraslati.length,
      'AUDIT_COMPATIBILITA_INCOMPLETO'
    );
  }

  verificaAttiva();

  return {
    ...validazione,

    versione:
      NCC_VALIDAZIONE_PRENOTAZIONI_VERSION,

    modalita:
      'VALIDAZIONE_LOGISTICA_PRENOTAZIONI',

    valida: true,
    approvabile: false,

    dettaglioPrenotazioni: dettaglio,

    diagnosticaPrenotazioni: {
      ...report,

      auditCompatibilitaRigoroso:
        auditCompatibilita !== null,

      serviziCompatibilitaPrenotazioniVerificata,

      routingPrima,
      routingDopo
    },

    audit: {
      ...validazione.audit,

      compatibilitaPrenotazioniIndipendenteVerificata:
        auditCompatibilita !== null,

      restrizioniGeograficheVerificate:
        auditCompatibilita !== null,

      compatibilitaProposteTraslateVerificata:
        auditCompatibilita !== null,

      serviziCompatibilitaPrenotazioniVerificata,

      vincoliPrenotazioniOriginaliVerificati: true,
      caricoFermateVerificato: true,
      percorrenzeIndividualiVerificate: true,
      ricaviOriginaliVerificati: true,

      vincoliVoliVerificati: true,

      voliPresenti:
        report.voliArrivoVerificati +
        report.voliPartenzaVerificati > 0,

      bagagliVerificati: false,
      disponibilitaOrariaVerificata: false,
      disponibilitaConducentiVerificata: false
    }
  };
}