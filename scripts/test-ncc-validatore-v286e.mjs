
import {
  testValidazioneNcc,
  testDomiciliNcc
} from './ncc-test-validazione-v286e.mjs';


import {
  creaMatriceCpsatNcc
} from '../services/ncc-matrice-cpsat.service.js';

import {
  eseguiCpsatNcc
} from '../services/ncc-cpsat-bridge.service.js';

import fs from 'node:fs';
import assert from 'node:assert/strict';

import {
  creaRoutingNcc,
  distanzaGeografica
} from '../services/ncc-routing-matrix.service.js';

import {
  creaCatalogoAdattivoNcc
} from '../services/ncc-catalogo-adattivo.service.js';

import {
  finestraServizioNcc
} from '../services/ncc-schedulazione-temporale.service.js';

const report = JSON.parse(
  fs.readFileSync(
    'ncc-benchmark-comparativo-v28-1795721379071.json',
    'utf8'
  )
);

const scenario = report.find(x =>
  x.risultato.versione === 'V2.8.0' &&
  x.risultato.scenario === '20/2'
);

assert.ok(scenario, 'SCENARIO NON TROVATO');

const prima = JSON.stringify(scenario);

const {
  rows: rowsOriginaliV290,
  veicoli: veicoliOriginaliV290,
  parametri
} = scenario.dataset;

// Normalizzazione flotta storica V2.8.0.
// Tipo assente nel benchmark: non viene inventata una categoria.
const veicoli = veicoliOriginaliV290.map(v => ({
  ...v,
  tipo: v.tipo === undefined ? null : v.tipo
}));

// Normalizzazione fixture storica V2.8.0.
// Il benchmark originale rimane invariato.
const rows = rowsOriginaliV290.map(row => ({
  ...row,
  origineTipiVeicoloAmmessi:
    row.origineTipiVeicoloAmmessi === undefined
      ? null
      : row.origineTipiVeicoloAmmessi,
  destinazioneTipiVeicoloAmmessi:
    row.destinazioneTipiVeicoloAmmessi === undefined
      ? null
      : row.destinazioneTipiVeicoloAmmessi
}));

const riferimento = Date.parse(
  '2026-11-27T00:00:00+01:00'
);

const luoghi = {
  'Aeroporto di Brindisi (BDS)': [40.6576, 17.9470],
  'Lecce': [40.3522, 18.1755],
  'Gallipoli': [40.0559, 17.9925],
  'Otranto': [40.1478, 18.4865],
  'Maglie': [40.1206, 18.2978],
  'Tricase': [39.9302, 18.3584],
  'Santa Maria di Leuca': [39.7975, 18.3560],
  'Nardo': [40.1798, 18.0314],
  'Galatina': [40.1743, 18.1700],
  'Porto Cesareo': [40.2610, 17.8940],
  'Ugento': [39.9271, 18.1580],
  'Santa Cesarea Terme': [40.0357, 18.4560]
};

const stats = {
  richiesteHTTP: 0,
  elementiHTTP: 0,
  geocodingAutonomo: 0,
  elementiAutorizzati: 0
};

const controller = new AbortController();

const deadline = Date.now() + 120000;

function verificaAttiva() {
  if (Date.now() >= deadline) {
    controller.abort();
    throw new Error('TIMEOUT_TEST_V286E');
  }

  if (controller.signal.aborted) {
    throw new Error('TEST_INTERROTTO');
  }
}

const routing = creaRoutingNcc({
  apiKey: 'TEST',
  signal: controller.signal,
  verificaAttiva,

  autorizzazioneRigorosa: true,
  richiediAutorizzazione: true,

  autorizzaRouting: async elementi => {
    verificaAttiva();

    assert.ok(
      Number.isSafeInteger(elementi) &&
      elementi > 0,
      'CONTRATTO AUTORIZZAZIONE NON VALIDO'
    );

    stats.elementiAutorizzati += elementi;

    assert.ok(
      stats.elementiAutorizzati <= 500,
      'BUDGET TEST ESAURITO'
    );

    return {
      consentito: true,
      elementiAutorizzati: elementi
    };
  },

  locate: async () => {
    stats.geocodingAutonomo++;

    throw new Error(
      'GEOCODING AUTONOMO VIETATO'
    );
  },

  fetchImpl: async url => {
    verificaAttiva();

    stats.richiesteHTTP++;

    const u = new URL(url);

    const origine =
      u.searchParams.get('origins');

    const destinazioni =
      u.searchParams.get('destinations').split('|');

    stats.elementiHTTP += destinazioni.length;

    function coord(s) {
      const [lat, lon] = s.split(',').map(Number);

      assert.ok(Number.isFinite(lat));
      assert.ok(Number.isFinite(lon));

      return { lat, lon };
    }

    const a = coord(origine);

    const elements = destinazioni.map(d => {
      const b = coord(d);

      const km =
        distanzaGeografica(a, b) * 1.25;

      const secondi = Math.ceil(
        km / 55 * 3600
      );

      return {
        status: 'OK',
        distance: {
          value: Math.round(km * 1000)
        },
        duration: {
          value: secondi
        }
      };
    });

    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        rows: [{ elements }]
      })
    };
  }
});

try {
  for (const [nome, [lat, lon]] of Object.entries(luoghi)) {
    routing.registraCoordinate(
      nome,
      { lat, lon }
    );
  }



  const input = {
    prenotazioni: rows,
    proposte: scenario.piano.proposte,
    veicoli,
    diagnostica: scenario.piano.diagnosticaAdattiva,
    routing,
    parametri,
    riferimento,
    verificaAttiva
  };

  // TEST 1: catalogo adattivo dinamico.

  const catalogo =
    await creaCatalogoAdattivoNcc(input);

  assert.equal(catalogo.servizi.length, 19);
console.log("\n=== AUDIT COMPATIBILITA CATALOGO V290 ===");
console.table(catalogo.servizi.map(s=>({servizio:s.id,prenotazioni:s.prenotazioni.join(","),passeggeri:s.passeggeri,picco:s.piccoPasseggeri,restrizioni:JSON.stringify(s.tipiVeicoloAmmessi),veicoliCompatibili:s.veicoliCompatibili.join(","),numeroVeicoli:s.veicoliCompatibili.length})));
console.log("COMBINAZIONI AMMESSE:",catalogo.servizi.reduce((n,s)=>n+s.veicoliCompatibili.length,0));
console.log("COMBINAZIONI TEORICHE:",catalogo.servizi.length*catalogo.veicoli.length);
console.log("FLOTTA:");
console.table(catalogo.veicoli.map(v=>({id:v.id,posti:v.posti,tipo:v.tipo})));
console.log("=== FINE AUDIT ===\n");


  const catalogoPrima =
    JSON.stringify(catalogo);

  const statsPrima = { ...stats };

  // TEST 2: matrice dinamica.

  const matrice =
    await creaMatriceCpsatNcc({
      catalogo,
      routing,
      verificaAttiva
    });

  const d = matrice.diagnosticaMatrice;

  assert.equal(d.trasferimenti, 342);
// AUDIT_V290_CAPienza_CONFERMATO
const esclusiPerCapienza = catalogo.servizi.filter(s => Number(s.piccoPasseggeri) > 4 && !s.veicoliCompatibili.includes("1")).map(s => s.id).sort();
assert.deepEqual(esclusiPerCapienza, ["S1","S10","S19","S2","S4","S5"]);
assert.equal(catalogo.servizi.reduce((n,s) => n+s.veicoliCompatibili.length,0),32);
assert.ok(catalogo.servizi.every(s => Number(s.piccoPasseggeri) <= 7 && s.veicoliCompatibili.includes("2")));

  assert.equal(d.posizionamenti, 32);
  assert.equal(d.rientri, 32);
  assert.equal(d.elementiLogici, 406);
  assert.equal(d.archiDirettiPotenziali, 73);

  assert.equal(d.basiRegistrate, 2);
  assert.equal(d.basiRiutilizzate, 0);

  assert.equal(
    JSON.stringify(catalogo),
    catalogoPrima
  );

  console.log('MATRICE DINAMICA: OK');

  const elementiMatrice =
    stats.elementiHTTP -
    statsPrima.elementiHTTP;

  const richiesteMatrice =
    stats.richiesteHTTP -
    statsPrima.richiesteHTTP;

  // TEST 3: regressione matrice V284.
  // Confronto per firma, non per ID servizio.

  const baseline = JSON.parse(
    fs.readFileSync(
      'ncc-input-cpsat-v284-1795721838544.json',
      'utf8'
    )
  );

  const idBaseline = new Map(
    baseline.servizi.map(s => [
      s.chiave,
      s.id
    ])
  );

  const equivalenze = new Map(
    matrice.servizi.map(s => [
      s.id,
      idBaseline.get(s.chiave)
    ])
  );

  assert.ok(
    [...equivalenze.values()].every(Boolean)
  );

  const firma = (...args) =>
    JSON.stringify(args);

  const trasferimentiBaseline = new Map(
    baseline.matrice.trasferimenti.map(t => [
      firma(t.da, t.a),
      t
    ])
  );

  for (const t of matrice.matrice.trasferimenti) {
    const b = trasferimentiBaseline.get(
      firma(
        equivalenze.get(t.da),
        equivalenze.get(t.a)
      )
    );

    assert.ok(b);

    assert.equal(
      t.distanzaMetri,
      b.distanzaMetri
    );

    assert.equal(t.durataMs, b.durataMs);

    assert.equal(
      t.condividonoPrenotazioni,
      b.condividonoPrenotazioni
    );

    assert.equal(
      t.margineMs,
      b.margineMs
    );

    assert.equal(
      t.direttoPotenzialmenteFattibile,
      b.direttoPotenzialmenteFattibile
    );
  }

  for (const tipo of [
    'posizionamenti',
    'rientri'
  ]) {
    const precedenti = new Map(
      baseline.matrice[tipo].map(t => [
        firma(t.veicolo, t.servizio),
        t
      ])
    );

    for (const t of matrice.matrice[tipo]) {
      const b = precedenti.get(
        firma(
          t.veicolo,
          equivalenze.get(t.servizio)
        )
      );

      assert.ok(b);

      assert.equal(
        t.distanzaMetri,
        b.distanzaMetri
      );

      assert.equal(t.durataMs, b.durataMs);
    }
  }

  console.log('REGRESSIONE MATRICE V284: OK');

  // TEST 4: ripetizione con basi gia registrate.

  const primaRipetizione =
    stats.elementiHTTP;

  const ripetuta =
    await creaMatriceCpsatNcc({
      catalogo,
      routing,
      verificaAttiva
    });

  assert.equal(
    ripetuta.diagnosticaMatrice.basiRegistrate,
    0
  );

  assert.equal(
    ripetuta.diagnosticaMatrice.basiRiutilizzate,
    2
  );

  assert.equal(
    stats.elementiHTTP,
    primaRipetizione
  );

  assert.deepEqual(
    ripetuta.matrice,
    matrice.matrice
  );

  console.log('RIUTILIZZO BASI: OK');
  console.log('RIUTILIZZO CACHE: OK');
  console.log('NUOVI ELEMENTI HTTP: 0');

  // TEST 5: risoluzione CP-SAT adattiva.

  async function risolvi(catalogoCompleto) {
    verificaAttiva();

    const r = await eseguiCpsatNcc({
      script: 'scripts/ncc-cpsat.py',

      input: {
        catalogo: catalogoCompleto,

        opzioni: {
          maxTempoSecondi: 5,
          workers: 2
        }
      },

      signal: controller.signal,
      timeoutMs: 15000
    });

    verificaAttiva();

    assert.equal(
      r.risultato.stato,
      'SOLUZIONE_DISPONIBILE'
    );

    assert.equal(
      r.risultato.ottimoCompleto,
      true
    );

    return r;
  }

  const adattiva = await risolvi(matrice);

  const sol = adattiva.risultato.soluzione;

  assert.equal(
    sol.prenotazioniAssegnate.length,
    20
  );

  assert.equal(
    sol.prenotazioniEscluse.length,
    0
  );

  assert.equal(
    new Set(sol.prenotazioniAssegnate).size,
    20
  );

  assert.equal(sol.missioni, 3);
  assert.equal(sol.veicoli, 2);

  assert.ok(
    Math.abs(sol.costoEuro - 531.45955) <
    0.000001
  );

  assert.ok(
    Math.abs(sol.kmTotali - 888.011) <
    0.000001
  );

  console.log('CP-SAT ADATTIVO: OK');

  // NCC_RIPRISTINO_CACHE_BENCHMARK_V286E33

  const elementiPrimaRipristino =
    stats.elementiHTTP;

  const tratteOriginali = new Map();

  function aggiungiTratta(a, b) {

    const k = JSON.stringify([a, b]);

    tratteOriginali.set(k, [a, b]);
  }

  for (const row of rows) {

    aggiungiTratta(
      row.origine,
      row.destinazione
    );
  }

  for (const proposta of scenario.piano.proposte) {

    const fermate = proposta.itinerario.fermate;

    for (let i = 1; i < fermate.length; i++) {

      aggiungiTratta(
        fermate[i - 1].localita,
        fermate[i].localita
      );
    }
  }

  for (const [a, b] of tratteOriginali.values()) {

    verificaAttiva();

    const t = await routing.tratta(a, b);

    assert.ok(
      t &&
      Number.isFinite(t.distanzaKm) &&
      Number.isFinite(t.durataMs),
      'TRATTA ORIGINALE NON DISPONIBILE'
    );
  }

  console.log(
    'ELEMENTI RIPRISTINO CACHE:',
    stats.elementiHTTP -
      elementiPrimaRipristino
  );

  const elementiPrimaValidazione =
    stats.elementiHTTP;

  const verifica = await testValidazioneNcc({
    catalogo: matrice,
    risultato: adattiva.risultato,
    prenotazioniOriginali: rows,
    veicoliOriginali: veicoli,
    routing,
    verificaAttiva
  });

  const elementiValidazione =
    stats.elementiHTTP -
    elementiPrimaValidazione;

  console.log(
    'ELEMENTI HTTP VALIDAZIONE:',
    elementiValidazione
  );

  console.log(
    'TEST POSITIVI:',
    verifica.positivi
  );

  console.log(
    'TEST NEGATIVI:',
    verifica.negativi
  );

  assert.equal(elementiValidazione, 0);

  const elementiPrimaDomicili =
    stats.elementiHTTP;

  const testDomicili =
    await testDomiciliNcc({
      routing,
      riferimento,
      verificaAttiva
    });

  assert.equal(testDomicili.length, 6);

  console.log(
    'ELEMENTI HTTP DOMICILI:',
    stats.elementiHTTP -
      elementiPrimaDomicili
  );

  console.log('TEST DOMICILIARI: OK');

  fs.writeFileSync(
    'ncc-validazione-v286e-' +
      Date.now() + '.json',

    JSON.stringify({
      versione: '2.8.6e.3',
      validazione: verifica.validazione,
      positivi: verifica.positivi,
      negativi: verifica.negativi,
      elementiValidazione,
      testDomicili
    }, null, 2)
  );

  // TEST 6: CP-SAT senza disaggregazione.

  const originali =
    await creaCatalogoAdattivoNcc({
      ...input,

      diagnostica: {
        candidatiDisaggregazione: []
      }
    });

  assert.equal(originali.servizi.length, 7);

  const matriceOriginale =
    await creaMatriceCpsatNcc({
      catalogo: originali,
      routing,
      verificaAttiva
    });

  const nonAdattiva =
    await risolvi(matriceOriginale);

  const solOriginale =
    nonAdattiva.risultato.soluzione;

  assert.equal(
    solOriginale.prenotazioniAssegnate.length,
    17
  );

  assert.equal(
    solOriginale.prenotazioniEscluse.length,
    3
  );

  console.log('CP-SAT SENZA DISAGGREGAZIONE: OK');

  // TEST 7: limiti matrice.

  await assert.rejects(
    creaMatriceCpsatNcc({
      catalogo,
      routing,
      verificaAttiva,

      limiti: {
        maxElementiLogici: 100
      }
    }),
    /NCC_MATRICE_LIMITE_ELEMENTI/
  );

  console.log('TEST LIMITE MATRICE: OK');

  // TEST 8: cancellazione.

  await assert.rejects(
    creaMatriceCpsatNcc({
      catalogo,
      routing,

      verificaAttiva: () => {
        throw new Error('TEST_CANCELLAZIONE');
      }
    }),
    /TEST_CANCELLAZIONE/
  );

  console.log('TEST CANCELLAZIONE: OK');

  // TEST 9: integrita finale.

  assert.equal(stats.geocodingAutonomo, 0);

  assert.equal(
    JSON.stringify(scenario),
    prima
  );

  assert.equal(
    routing.diagnostica().interrotta,
    false
  );

  assert.equal(
    routing.diagnostica().budgetEsaurito,
    false
  );

  console.table([
    {
      modello: 'CP-SAT originale',
      assegnate:
        solOriginale.prenotazioniAssegnate.length,
      escluse:
        solOriginale.prenotazioniEscluse.length,
      missioni: solOriginale.missioni,
      costo: solOriginale.costoEuro,
      km: solOriginale.kmTotali,
      durataMs: nonAdattiva.durataMs
    },
    {
      modello: 'CP-SAT adattivo',
      assegnate:
        sol.prenotazioniAssegnate.length,
      escluse:
        sol.prenotazioniEscluse.length,
      missioni: sol.missioni,
      costo: sol.costoEuro,
      km: sol.kmTotali,
      durataMs: adattiva.durataMs
    }
  ]);

  const timestamp = Date.now();

  const nomeInput =
    'ncc-input-cpsat-v286e-' +
    timestamp + '.json';

  const nomeSoluzione =
    'ncc-soluzione-cpsat-v286e-' +
    timestamp + '.json';

  fs.writeFileSync(
    nomeInput,
    JSON.stringify(matrice, null, 2)
  );

  fs.writeFileSync(
    nomeSoluzione,
    JSON.stringify(adattiva.risultato, null, 2)
  );

  console.log('\n--- TEST V2.8.6e ---');

  console.log('SERVIZI:', d.servizi);
  console.log('TRASFERIMENTI:', d.trasferimenti);
  console.log('POSIZIONAMENTI:', d.posizionamenti);
  console.log('RIENTRI:', d.rientri);
  console.log('ELEMENTI LOGICI:', d.elementiLogici);
  console.log('TRATTE UNICHE:', d.tratteUniche);
  console.log('ORIGINI UNICHE:', d.originiUniche);
  console.log('CHIAMATE MATRIX:', d.chiamateMatrix);
  console.log('TRATTE RIUTILIZZATE:', d.tratteRiutilizzate);
  console.log('ARCHI DIRETTI:', d.archiDirettiPotenziali);

  console.log('HTTP SOLO MATRICE:', richiesteMatrice);
  console.log('ELEMENTI SOLO MATRICE:', elementiMatrice);

  console.log('HTTP TOTALI:', stats.richiesteHTTP);
  console.log('ELEMENTI HTTP TOTALI:', stats.elementiHTTP);

  console.log('GEOCODING AUTONOMO:', stats.geocodingAutonomo);
  console.log('DURATA MATRICE MS:', d.durataMs);

  console.log('PIANO ORIGINALE: INALTERATO');
  console.log('INPUT:', nomeInput);
  console.log('SOLUZIONE:', nomeSoluzione);

  console.log('TEST V2.8.6e SUPERATO');

} finally {
  controller.abort();
}
