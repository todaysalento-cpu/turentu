export const NCC_MATRICE_CPSAT_VERSION = '2.8.6d';

export const NCC_MATRICE_LIMITI = Object.freeze({
  maxServizi: 150,
  maxVeicoli: 20,
  maxElementiLogici: 30000,
  maxTratteUniche: 5000,
  maxDestinazioniBatch: 25
});

export async function creaMatriceCpsatNcc({
  catalogo,
  routing,
  verificaAttiva = () => {},
  limiti = {}
}) {

  verificaAttiva();

  const config = {
    ...NCC_MATRICE_LIMITI,
    ...limiti
  };

  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        'NCC_MATRICE_LIMITE_INVALIDO: ' + key
      );
    }
  }

  if (
    !catalogo ||
    !Array.isArray(catalogo.servizi) ||
    !Array.isArray(catalogo.veicoli)
  ) {
    throw new Error('NCC_MATRICE_CATALOGO_INVALIDO');
  }

  if (
    typeof routing?.matrix !== 'function' ||
    typeof routing?.coordinate !== 'function' ||
    typeof routing?.registraCoordinate !== 'function' ||
    typeof routing?.diagnostica !== 'function'
  ) {
    throw new Error('NCC_MATRICE_ROUTING_INVALIDO');
  }

  const { servizi, veicoli } = catalogo;

  if (
    servizi.length > config.maxServizi ||
    veicoli.length > config.maxVeicoli
  ) {
    throw new Error('NCC_MATRICE_LIMITE_CATALOGO');
  }

  const elementiLogici =
    servizi.length * (servizi.length - 1) +
    2 * servizi.length * veicoli.length;

  if (elementiLogici > config.maxElementiLogici) {
    throw new Error('NCC_MATRICE_LIMITE_ELEMENTI');
  }

  if (
    new Set(servizi.map(s => s.id)).size !==
    servizi.length
  ) {
    throw new Error('NCC_MATRICE_SERVIZI_DUPLICATI');
  }

  if (
    new Set(veicoli.map(v => v.id)).size !==
    veicoli.length
  ) {
    throw new Error('NCC_MATRICE_VEICOLI_DUPLICATI');
  }

  const inizio = Date.now();

  const routingPrima = structuredClone(
    routing.diagnostica()
  );

  if (
    routingPrima.autorizzazioneRigorosa !== true ||
    routingPrima.geocodingAutonomoConsentito !== false
  ) {
    throw new Error(
      'NCC_MATRICE_ROUTING_NON_RIGOROSO'
    );
  }

  if (
    routingPrima.interrotta ||
    routingPrima.budgetEsaurito
  ) {
    throw new Error(
      'NCC_MATRICE_ROUTING_NON_DISPONIBILE'
    );
  }

  const basi = new Map();

  const coordinateBasi = new Map();

  const richieste = new Map();

  const cache = new Map();

  const firma = (a, b) =>
    JSON.stringify([a, b]);

  const report = {
    versione: NCC_MATRICE_CPSAT_VERSION,
    servizi: servizi.length,
    veicoli: veicoli.length,
    elementiLogici,
    basiRegistrate: 0,
    basiRiutilizzate: 0,
    tratteUniche: 0,
    originiUniche: 0,
    chiamateMatrix: 0,
    tratteRiutilizzate: 0,
    trasferimenti: 0,
    posizionamenti: 0,
    rientri: 0,
    archiDirettiPotenziali: 0,
    archiConPrenotazioniCondivise: 0,
    archiTemporalmenteImpossibili: 0,
    durataMs: 0
  };

  function richiediTratta(a, b) {

    if (
      typeof a !== 'string' ||
      typeof b !== 'string' ||
      !a.trim() ||
      !b.trim()
    ) {
      throw new Error(
        'NCC_MATRICE_LOCALITA_INVALIDA'
      );
    }

    if (!richieste.has(a)) {
      richieste.set(a, new Set());
    }

    richieste.get(a).add(b);
  }

  function normalizza(t, a, b) {

    if (
      !t ||
      !Number.isFinite(t.distanzaKm) ||
      t.distanzaKm < 0 ||
      !Number.isSafeInteger(t.durataMs) ||
      t.durataMs < 0
    ) {
      throw new Error(
        'NCC_MATRICE_TRATTA_NON_DISPONIBILE: ' +
        a + ' -> ' + b
      );
    }

    const distanzaMetri = Math.round(
      t.distanzaKm * 1000
    );

    if (!Number.isSafeInteger(distanzaMetri)) {
      throw new Error(
        'NCC_MATRICE_DISTANZA_INVALIDA'
      );
    }

    return {
      distanzaMetri,
      durataMs: t.durataMs
    };
  }

  function leggiTratta(a, b) {

    const t = cache.get(firma(a, b));

    if (!t) {
      throw new Error(
        'NCC_MATRICE_CACHE_INCOMPLETA: ' +
        a + ' -> ' + b
      );
    }

    return t;
  }

  // FASE 1: identificazione basi operative.

  for (const v of veicoli) {

    verificaAttiva();

    if (
      v.lat == null ||
      v.lon == null ||
      !Number.isFinite(v.lat) ||
      !Number.isFinite(v.lon) ||
      Math.abs(v.lat) > 90 ||
      Math.abs(v.lon) > 180 ||
      (v.lat === 0 && v.lon === 0)
    ) {
      throw new Error(
        'NCC_MATRICE_BASE_INVALIDA: ' + v.id
      );
    }

    const nome =
      '__BASE_NCC__' + v.lat + ',' + v.lon;

    coordinateBasi.set(nome, {
      lat: v.lat,
      lon: v.lon
    });

    basi.set(v.id, nome);
  }

  // FASE 2: raccolta delle tratte necessarie.

  for (const a of servizi) {

    verificaAttiva();

    if (
      !Array.isArray(a.prenotazioni) ||
      !Number.isSafeInteger(a.inizioMinimoMs) ||
      !Number.isSafeInteger(a.inizioMassimoMs) ||
      !Number.isSafeInteger(a.durataMs) ||
      a.inizioMinimoMs < 0 ||
      a.inizioMassimoMs < a.inizioMinimoMs ||
      a.durataMs <= 0
    ) {
      throw new Error(
        'NCC_MATRICE_SERVIZIO_INVALIDO: ' + a.id
      );
    }

    for (const b of servizi) {

      if (a.id === b.id) continue;

      richiediTratta(
        a.destinazione,
        b.origine
      );
    }
  }

  for (const v of veicoli) {

    verificaAttiva();

    const base = basi.get(v.id);

    for (const s of servizi) {

      richiediTratta(
        base,
        s.origine
      );

      richiediTratta(
        s.destinazione,
        base
      );
    }
  }

  report.originiUniche = richieste.size;

  report.tratteUniche = [...richieste.values()]
    .reduce((totale, set) =>
      totale + set.size, 0
    );

  if (
    report.tratteUniche >
    config.maxTratteUniche
  ) {
    throw new Error(
      'NCC_MATRICE_LIMITE_TRATTE_UNICHE'
    );
  }

  // Registra le basi solo dopo i controlli.

  for (const [nome, coordinate] of coordinateBasi) {

    verificaAttiva();

    const esistente =
      await routing.coordinate(nome);

    verificaAttiva();

    if (esistente) {
      if (
        esistente.lat !== coordinate.lat ||
        esistente.lon !== coordinate.lon
      ) {
        throw new Error(
          'NCC_MATRICE_BASE_CONFLITTO: ' + nome
        );
      }

      report.basiRiutilizzate++;
    } else {
      routing.registraCoordinate(
        nome,
        coordinate
      );

      report.basiRegistrate++;
    }
  }

  // FASE 3: routing raggruppato per origine.

  for (const [origine, destinazioni] of richieste) {

    verificaAttiva();

    const elenco = [...destinazioni];

    for (
      let i = 0;
      i < elenco.length;
      i += config.maxDestinazioniBatch
    ) {

      verificaAttiva();

      const batch = elenco.slice(
        i,
        i + config.maxDestinazioniBatch
      );

      const tratte = await routing.matrix(
        origine,
        batch
      );

      verificaAttiva();

      report.chiamateMatrix++;

      if (
        !Array.isArray(tratte) ||
        tratte.length !== batch.length
      ) {
        throw new Error(
          'NCC_MATRICE_RISPOSTA_INCOMPLETA'
        );
      }

      for (let j = 0; j < batch.length; j++) {

        const destinazione = batch[j];

        const t = normalizza(
          tratte[j],
          origine,
          destinazione
        );

        cache.set(
          firma(origine, destinazione),
          t
        );
      }
    }
  }

  // FASE 4: trasferimenti tra servizi.

  const trasferimenti = [];

  for (const a of servizi) {

    verificaAttiva();

    const idsA = new Set(
      a.prenotazioni.map(String)
    );

    for (const b of servizi) {

      if (a.id === b.id) continue;

      const t = leggiTratta(
        a.destinazione,
        b.origine
      );

      const condividonoPrenotazioni =
        b.prenotazioni.some(
          id => idsA.has(String(id))
        );

      const margineMs =
        b.inizioMassimoMs -
        a.inizioMinimoMs -
        a.durataMs -
        t.durataMs;

      const direttoPotenzialmenteFattibile =
        !condividonoPrenotazioni &&
        margineMs >= 0;

      if (condividonoPrenotazioni) {
        report.archiConPrenotazioniCondivise++;
      }

      if (margineMs < 0) {
        report.archiTemporalmenteImpossibili++;
      }

      if (direttoPotenzialmenteFattibile) {
        report.archiDirettiPotenziali++;
      }

      trasferimenti.push({
        da: a.id,
        a: b.id,
        ...t,
        condividonoPrenotazioni,
        margineMs,
        direttoPotenzialmenteFattibile
      });
    }
  }

  // FASE 5: posizionamenti e rientri.

  const posizionamenti = [];
  const rientri = [];

  for (const v of veicoli) {

    verificaAttiva();

    const base = basi.get(v.id);

    for (const s of servizi) {

      posizionamenti.push({
        veicolo: v.id,
        servizio: s.id,

        ...leggiTratta(
          base,
          s.origine
        )
      });

      rientri.push({
        veicolo: v.id,
        servizio: s.id,

        ...leggiTratta(
          s.destinazione,
          base
        )
      });
    }
  }

  report.trasferimenti =
    trasferimenti.length;

  report.posizionamenti =
    posizionamenti.length;

  report.rientri =
    rientri.length;

  report.tratteRiutilizzate =
    elementiLogici - cache.size;

  const totale =
    trasferimenti.length +
    posizionamenti.length +
    rientri.length;

  if (totale !== elementiLogici) {
    throw new Error(
      'NCC_MATRICE_CONTEGGIO_INCOERENTE'
    );
  }

  if (cache.size !== report.tratteUniche) {
    throw new Error(
      'NCC_MATRICE_TRATTE_INCOMPLETE'
    );
  }

  verificaAttiva();

  const routingDopo = structuredClone(
    routing.diagnostica()
  );

  if (
    routingDopo.interrotta ||
    routingDopo.budgetEsaurito
  ) {
    throw new Error(
      'NCC_MATRICE_ROUTING_NON_COMPLETATO'
    );
  }

  report.durataMs = Date.now() - inizio;

  return {
    ...structuredClone(catalogo),

    versioneCatalogo: catalogo.versione,

    versione: NCC_MATRICE_CPSAT_VERSION,

    modalita: 'INPUT_CP_SAT_DINAMICO',

    approvabile: false,

    matrice: {
      trasferimenti,
      posizionamenti,
      rientri
    },

    diagnosticaMatrice: {
      ...report,
      routingPrima,
      routingDopo
    }
  };
}