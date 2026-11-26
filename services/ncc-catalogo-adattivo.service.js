import {
  finestraServizioNcc
} from './ncc-schedulazione-temporale.service.js';

import {
  validaPartizioniNcc
} from './ncc-validazione-partizioni.service.js';

export const NCC_CATALOGO_ADATTIVO_VERSION = '2.8.6c';

export const NCC_CATALOGO_LIMITI = Object.freeze({
  maxGruppi: 4,
  maxPrenotazioni: 8,
  maxPartizioni: 500,
  maxSottogruppi: 255,
  maxServizi: 150,
  maxVeicoli: 20
});

const firma = ids =>
  JSON.stringify(ids.map(String).sort());

export async function creaCatalogoAdattivoNcc({
  prenotazioni,
  proposte,
  veicoli,
  diagnostica,
  routing,
  parametri = {},
  riferimento,
  durataGiornoMs = 86400000,
  verificaAttiva = () => {},
  limiti = {}
}) {

  verificaAttiva();

  const config = {
    ...NCC_CATALOGO_LIMITI,
    ...limiti
  };

  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        'NCC_CATALOGO_LIMITE_INVALIDO: ' + key
      );
    }
  }

  if (
    !Array.isArray(prenotazioni) ||
    !Array.isArray(proposte) ||
    !Array.isArray(veicoli)
  ) {
    throw new Error('NCC_CATALOGO_INPUT_INVALIDO');
  }

  if (!Number.isSafeInteger(riferimento)) {
    throw new Error('NCC_CATALOGO_RIFERIMENTO_INVALIDO');
  }

  if (![82800000, 86400000, 90000000]
      .includes(durataGiornoMs)) {
    throw new Error('NCC_CATALOGO_GIORNO_INVALIDO');
  }

  if (
    veicoli.length > config.maxVeicoli ||
    proposte.length > config.maxServizi
  ) {
    throw new Error('NCC_CATALOGO_LIMITE_BASE');
  }

  const attesaMassimaMs =
    parametri.attesaMassimaMinuti * 60000;

  const durataMassimaMissioneMs =
    parametri.durataMassimaMissioneMinuti * 60000;

  if (
    !Number.isSafeInteger(attesaMassimaMs) ||
    attesaMassimaMs < 0 ||
    !Number.isSafeInteger(durataMassimaMissioneMs) ||
    durataMassimaMissioneMs <= 0
  ) {
    throw new Error('NCC_CATALOGO_VINCOLI_INVALIDI');
  }

  const rows = new Map(
    prenotazioni.map(r => [String(r.id), r])
  );

  if (rows.size !== prenotazioni.length) {
    throw new Error('NCC_CATALOGO_PRENOTAZIONI_DUPLICATE');
  }

  const flotta = veicoli.map(v => {
    const id = String(v.id);

    const costoKm =
      parametri.costiVeicoli?.[id];

    const posti = Number(v.posti_totali);

    const lat = Number(v.lat);
    const lon = Number(v.lon);

    if (
      !Number.isFinite(costoKm) ||
      costoKm < 0 ||
      !Number.isSafeInteger(posti) ||
      posti < 1 ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      v.lat == null ||
      v.lon == null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0)
    ) {
      throw new Error(
        'NCC_CATALOGO_VEICOLO_INVALIDO: ' + id
      );
    }

    return {
      id,
      posti,
      base: v.localita,
      lat,
      lon,
      costoKm,
      veicolo: structuredClone(v)
    };
  });

  if (
    new Set(flotta.map(v => v.id)).size !==
    flotta.length
  ) {
    throw new Error('NCC_CATALOGO_VEICOLI_DUPLICATI');
  }

  const servizi = [];
  const firme = new Set();
  const gruppiOriginali = new Map();
  const idsOriginali = new Set();

  const report = {
    versione: NCC_CATALOGO_ADATTIVO_VERSION,
    gruppiOriginali: proposte.length,
    originaliConservati: 0,
    candidatiIndividuati: 0,
    candidatiElaborati: 0,
    alternativeAggiunte: 0,
    duplicatiEvitati: 0,
    limiteRaggiunto: false,
    gruppiSaltati: [],
    serviziRifiutati: [],
    validazioni: []
  };

  function aggiungiServizio(
    proposta,
    famiglia,
    origineServizio
  ) {

    verificaAttiva();

    const ids =
      proposta.prenotazioni.map(String).sort();

    const key = firma(ids);

    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !ids.every(id => rows.has(id))
    ) {
      throw new Error(
        'NCC_CATALOGO_IDENTITA_INVALIDA: ' + key
      );
    }

    if (firme.has(key)) {
      report.duplicatiEvitati++;
      return false;
    }

    if (servizi.length >= config.maxServizi) {
      report.limiteRaggiunto = true;
      return false;
    }

    const f = finestraServizioNcc(proposta);

    const picco = Number(
      proposta.piccoPasseggeri
    );

    const passeggeri = Number(
      proposta.passeggeri
    );

    const compatibili = flotta
      .filter(v => v.posti >= picco)
      .map(v => v.id);

    const distanzaMetri = Math.round(
      proposta.itinerario?.km * 1000
    );

    const ricaviCentesimi =
      proposta.economia?.ricaviCentesimi ?? null;

    const inizioMinimoMs =
      f ? f.minimo - riferimento : null;

    const inizioMassimoMs =
      f ? f.massimo - riferimento : null;

    const fermate = proposta.itinerario?.fermate;

    const origine = fermate?.[0]?.localita;
    const destinazione = fermate?.at(-1)?.localita;

    const valido =
      f &&
      Number.isSafeInteger(inizioMinimoMs) &&
      Number.isSafeInteger(inizioMassimoMs) &&
      Number.isSafeInteger(f.durataMs) &&
      inizioMinimoMs >= 0 &&
      inizioMassimoMs >= inizioMinimoMs &&
      f.durataMs > 0 &&
      inizioMinimoMs + f.durataMs < durataGiornoMs &&
      Number.isSafeInteger(picco) &&
      picco > 0 &&
      Number.isSafeInteger(passeggeri) &&
      passeggeri >= picco &&
      Number.isSafeInteger(distanzaMetri) &&
      distanzaMetri >= 0 &&
      compatibili.length > 0 &&
      typeof origine === 'string' &&
      origine.length > 0 &&
      typeof destinazione === 'string' &&
      destinazione.length > 0;

    if (!valido) {
      report.serviziRifiutati.push({
        prenotazioni: ids,
        famiglia,
        motivo: 'SERVIZIO_NON_COMPATIBILE'
      });

      return false;
    }

    servizi.push({
      id: 'S' + (servizi.length + 1),

      famiglia,
      origineServizio,

      chiave: key,

      prenotazioni: ids,
      numeroPrenotazioni: ids.length,

      passeggeri,
      piccoPasseggeri: picco,

      origine,
      destinazione,

      inizioMinimoMs,

      inizioMassimoMs: Math.min(
        inizioMassimoMs,
        durataGiornoMs - 1 - f.durataMs
      ),

      durataMs: f.durataMs,
      distanzaMetri,
      ricaviCentesimi,

      veicoliCompatibili: compatibili,

      proposta: {
        ...structuredClone(proposta),
        approvabile: false
      }
    });

    firme.add(key);

    return true;
  }

  // FASE 1: conserva i gruppi originali.

  for (const proposta of proposte) {
    verificaAttiva();

    const ids = proposta.prenotazioni.map(String);

    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !ids.every(id => rows.has(id))
    ) {
      throw new Error(
        'NCC_CATALOGO_GRUPPO_ORIGINALE_INVALIDO'
      );
    }

    const key = firma(ids);

    for (const id of ids) {
      if (idsOriginali.has(id)) {
        throw new Error(
          'NCC_CATALOGO_GRUPPI_SOVRAPPOSTI: ' + id
        );
      }

      idsOriginali.add(id);
    }

    gruppiOriginali.set(key, proposta);

    if (aggiungiServizio(
      proposta,
      key,
      'ORIGINALE'
    )) {
      report.originaliConservati++;
    }
  }

  // FASE 2: individua i candidati dalla diagnostica.

  const candidati = new Map();

  for (const candidato of
    diagnostica?.candidatiDisaggregazione ?? []) {

    verificaAttiva();

    const key = firma(candidato.prenotazioni);

    const originale = gruppiOriginali.get(key);

    if (!originale) {
      report.gruppiSaltati.push({
        chiave: key,
        motivo: 'GRUPPO_NON_PRESENTE'
      });

      continue;
    }

    if (originale.prenotazioni.length < 2) {
      continue;
    }

    candidati.set(key, originale);
  }

  report.candidatiIndividuati = candidati.size;

  // FASE 3: validazione selettiva delle alternative.

  for (const [key, gruppo] of candidati) {
    verificaAttiva();

    if (
      report.candidatiElaborati >= config.maxGruppi ||
      servizi.length >= config.maxServizi
    ) {
      report.limiteRaggiunto = true;
      break;
    }

    if (
      gruppo.prenotazioni.length >
      config.maxPrenotazioni
    ) {
      report.limiteRaggiunto = true;

      report.gruppiSaltati.push({
        chiave: key,
        motivo: 'LIMITE_PRENOTAZIONI_GRUPPO'
      });

      continue;
    }

    const subset = gruppo.prenotazioni.map(
      id => structuredClone(rows.get(String(id)))
    );

    const risultato = await validaPartizioniNcc({
      prenotazioni: subset,
      veicoli,
      routing,
      parametri,
      riferimento,
      verificaAttiva,

      maxPrenotazioni: config.maxPrenotazioni,
      maxPartizioni: config.maxPartizioni,
      maxSottogruppi: config.maxSottogruppi
    });

    verificaAttiva();

    report.candidatiElaborati++;

    if (risultato.limiteRaggiunto) {
      report.limiteRaggiunto = true;
    }

    report.validazioni.push({
      chiave: key,
      stato: risultato.stato,
      partizioniGenerate:
        risultato.partizioniGenerate,
      sottogruppiVerificati:
        risultato.sottogruppiVerificati,
      sottogruppiValidi:
        risultato.sottogruppiValidi,
      sottogruppiRifiutati:
        risultato.sottogruppiRifiutati,
      limiteRaggiunto:
        risultato.limiteRaggiunto
    });

    for (const alternativa of risultato.catalogo) {
      verificaAttiva();

      if (aggiungiServizio(
        alternativa,
        key,
        'ALTERNATIVA'
      )) {
        report.alternativeAggiunte++;
      }

      if (servizi.length >= config.maxServizi) {
        report.limiteRaggiunto = true;
        break;
      }
    }
  }

  // FASE 4: verifica copertura del catalogo.

  const copertura = prenotazioni.map(r => ({
    prenotazione: String(r.id),

    servizi: servizi
      .filter(s =>
        s.prenotazioni.includes(String(r.id))
      )
      .map(s => s.id)
  }));

  const senzaServizi = copertura
    .filter(r => !r.servizi.length)
    .map(r => r.prenotazione);

  report.serviziTotali = servizi.length;

  report.prenotazioniTotali =
    prenotazioni.length;

  report.prenotazioniCoperte =
    prenotazioni.length - senzaServizi.length;

  report.prenotazioniSenzaServizi =
    senzaServizi;

  report.coperturaPercentuale =
    prenotazioni.length
      ? report.prenotazioniCoperte /
        prenotazioni.length * 100
      : 100;

  verificaAttiva();

  return {
    versione: NCC_CATALOGO_ADATTIVO_VERSION,
    modalita: 'CATALOGO_CP_SAT_DINAMICO',
    approvabile: false,

    riferimento,
    durataGiornoMs,

    prenotazioni: structuredClone(prenotazioni),
    veicoli: flotta,
    parametri: structuredClone(parametri),

    vincoli: {
      attesaMassimaMs,
      durataMassimaMissioneMs
    },

    servizi,
    copertura,

    diagnosticaCatalogo: report
  };
}