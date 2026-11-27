// NCC_TEST_DISAGGREGAZIONE_CATEGORIA_V2902E2F3E
// NCC_TEST_GRUPPO_SINGOLO_V2902E2F3D\n// NCC_TEST_GRUPPO_INCOMPATIBILE_V2902E2F3C
// NCC_TEST_CONFLITTO_GEO_V2902E2F3B

import {
  ottimizzaIbridoNcc
} from '../services/ncc-ottimizzazione-ibrida.service.js';


import {
  creaMatriceCpsatNcc
} from '../services/ncc-matrice-cpsat.service.js';

import {
  eseguiCpsatNcc
} from '../services/ncc-cpsat-bridge.service.js';

import {
  validaMissioniNcc
} from '../services/ncc-validazione-missioni.service.js';

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

// NCC_FIXTURE_V2902E2F2C2A

// Adeguamento del benchmark sintetico storico.
// Nessuna modifica al dataset originale.

const {
  rows: rowsStoriche,
  veicoli: veicoliStorici,
  parametri
} = scenario.dataset;

// NCC_TEST_RESTRIZIONI_V2902E2F3A

const restrizioniPerId = new Map();

for (const id of [
  7, 8, 9, 10, 11, 12,
  13, 14, 19, 20
]) {
  restrizioniPerId.set(String(id), ['minivan']);
}

for (const id of [15, 16, 17, 18]) {
  restrizioniPerId.set(String(id), ['berlina']);
}

const rows = rowsStoriche.map(r => ({
  ...structuredClone(r),

  origineTipiVeicoloAmmessi:
    structuredClone(
      restrizioniPerId.get(String(r.id)) ?? null
    ),

  destinazioneTipiVeicoloAmmessi: null
}));

const veicoli = veicoliStorici.map(v => ({
  ...structuredClone(v),

  tipo: String(v.id) === '1'
    ? 'berlina'
    : 'minivan'
}));

console.log('FIXTURE V290:', {
  prenotazioni: rows.length,
  veicoli: veicoli.length,
  restrizioniEsplicite: rows.every(r =>
    Object.hasOwn(r, 'origineTipiVeicoloAmmessi') &&
    Object.hasOwn(r, 'destinazioneTipiVeicoloAmmessi')
  ),
  tipiEspliciti: veicoli.every(v =>
    Object.hasOwn(v, 'tipo')
  )
});

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

const deadline = Date.now() + 60000;

function verificaAttiva() {
  if (Date.now() >= deadline) {
    controller.abort();
    throw new Error('TIMEOUT_TEST_V286D');
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





  const pianoOriginale = {
    missioni: scenario.piano.missioni,

    riepilogo:
      scenario.piano.riepilogoMissioni,

    ottimizzazione:
      scenario.piano.ottimizzazione,

    diagnosticaAdattiva:
      scenario.piano.diagnosticaAdattiva
  };

  const aggregazione = {
    proposte: scenario.piano.proposte
  };

  const righePerId = new Map(
    rows.map(r => [String(r.id), r])
  );

  const flottaPerId = new Map(
    veicoli.map(v => [String(v.id), v])
  );

  assert.equal(rows.length, 20);
  assert.equal(veicoli.length, 2);
  assert.equal(flottaPerId.get('1').posti_totali, 4);
  assert.equal(flottaPerId.get('2').posti_totali, 7);

  function verificaAssegnazioni(piano, nome) {

    const assegnate = new Set();

    let limitate = 0;
    let libere = 0;

    for (const m of piano.missioni) {

      const v = flottaPerId.get(
        String(m.veicoloId)
      );

      assert.ok(v, 'VEICOLO NON RICONOSCIUTO');

      for (const g of m.gruppi) {

        assert.ok(
          Number(g.piccoPasseggeri) <=
          Number(v.posti_totali),
          'CAPIENZA SUPERATA'
        );

        for (const id of g.prenotazioni) {

          const k = String(id);
          const r = righePerId.get(k);

          assert.ok(r, 'PRENOTAZIONE SCONOSCIUTA');

          assert.ok(
            !assegnate.has(k),
            'PRENOTAZIONE DUPLICATA: ' + k
          );

          assegnate.add(k);

          const vincoli = [
            r.origineTipiVeicoloAmmessi,
            r.destinazioneTipiVeicoloAmmessi
          ];

          for (const ammessi of vincoli) {

            if (ammessi === null) continue;

            assert.ok(
              Array.isArray(ammessi) &&
              ammessi.includes(v.tipo),
              'VIOLAZIONE GEOGRAFICA: ' +
              k + ' / ' + v.tipo
            );
          }

          if (vincoli.some(x => x !== null)) {
            limitate++;
          } else {
            libere++;
          }
        }
      }
    }

    console.log(nome, {
      assegnate: assegnate.size,
      limitate,
      libere,
      violazioni: 0
    });

    return assegnate;
  }

  verificaAssegnazioni(
    pianoOriginale,
    'PIANO ORDINARIO COMPATIBILE'
  );

  const input = {
    pianoOriginale,
    aggregazione,

    prenotazioni: rows,
    veicoli,
    routing,
    parametri,
    riferimento,

    giorno: '2026-11-27',

    signal: controller.signal,
    verificaAttiva
  };

  const snapshot = JSON.stringify({
    pianoOriginale,
    aggregazione,
    rows,
    veicoli,
    parametri
  });

  const elementiIniziali =
    stats.elementiHTTP;

  // TEST 1: flag disabilitato.

  const disabilitato =
    await ottimizzaIbridoNcc(input);

  assert.equal(
    disabilitato.piano,
    pianoOriginale
  );

  assert.equal(
    disabilitato.diagnostica.motivo,
    'FLAG_DISABILITATO'
  );

  assert.equal(
    disabilitato.diagnostica.tentato,
    false
  );

  assert.equal(
    stats.elementiHTTP,
    elementiIniziali
  );

  console.log('FLAG DISABILITATO: OK');

  // TEST 2: nessun candidato.

  const senzaCandidati = {
    ...pianoOriginale,

    diagnosticaAdattiva: {
      candidatiDisaggregazione: []
    }
  };

  const nonNecessario =
    await ottimizzaIbridoNcc({
      ...input,
      abilitato: true,
      pianoOriginale: senzaCandidati
    });

  assert.equal(
    nonNecessario.piano,
    senzaCandidati
  );

  assert.equal(
    nonNecessario.diagnostica.motivo,
    'NESSUN_CANDIDATO_DISAGGREGAZIONE'
  );

  assert.equal(
    stats.elementiHTTP,
    elementiIniziali
  );

  console.log('NESSUN CANDIDATO: OK');

  // TEST 3: limite veicoli.

  const troppiVeicoli =
    Array.from(
      { length: 21 },
      (_, i) => ({
        ...veicoli[0],
        id: i + 100
      })
    );

  const limite =
    await ottimizzaIbridoNcc({
      ...input,
      abilitato: true,
      veicoli: troppiVeicoli
    });

  assert.equal(
    limite.piano,
    pianoOriginale
  );

  assert.equal(
    limite.diagnostica.motivo,
    'LIMITE_VEICOLI'
  );

  assert.equal(
    stats.elementiHTTP,
    elementiIniziali
  );

  console.log('LIMITE VEICOLI: OK');

  // TEST 4A: verifica catalogo per categoria.

  const catalogo = await creaCatalogoAdattivoNcc({
    prenotazioni: rows,
    proposte: aggregazione.proposte,
    veicoli,
    diagnostica: pianoOriginale.diagnosticaAdattiva,
    routing,
    parametri,
    riferimento,
    verificaAttiva
  });

  const idsTarget = new Set(['13', '14', '15']);

  const serviziTarget = catalogo.servizi.filter(
    servizio => servizio.prenotazioni
      .some(id => idsTarget.has(String(id)))
  );

  const firme = serviziTarget.map(
    servizio => servizio.prenotazioni
      .map(String).sort().join(',')
  ).sort();

  console.log('ALTERNATIVE GRUPPO F3E:', firme);

  assert.deepEqual(
    firme,
    ['13', '13,14', '14', '15'].sort()
  );

  for (const servizio of serviziTarget) {

    const ids = servizio.prenotazioni.map(String);

    const contieneBerlina = ids.includes('15');

    const contieneMinivan =
      ids.includes('13') || ids.includes('14');

    assert.ok(
      !(contieneBerlina && contieneMinivan),
      'SERVIZIO CON CATEGORIE INCOMPATIBILI'
    );

    const tipoAtteso =
      contieneBerlina ? 'berlina' : 'minivan';

    const veicoloAtteso =
      contieneBerlina ? '1' : '2';

    assert.deepEqual(
      servizio.tipiVeicoloAmmessi,
      [tipoAtteso]
    );

    assert.deepEqual(
      servizio.veicoliCompatibili.map(String),
      [veicoloAtteso]
    );

    assert.deepEqual(
      servizio.proposta.tipiVeicoloAmmessi,
      [tipoAtteso]
    );
  }

  assert.equal(catalogo.prenotazioni.length, 20);

  console.log('CATALOGO COMPLETO: OK');
  console.log('PARTIZIONI PER CATEGORIA: OK');
  console.log('COMPATIBILITA ALTERNATIVE: OK');

  // TEST 4B: recupero effettivo CP-SAT.

  const avvio = Date.now();

  const ibrido =
    await ottimizzaIbridoNcc({
      ...input,
      abilitato: true
    });

  const piano = ibrido.piano;
  const d = ibrido.diagnostica;



  console.log(
    'DIAGNOSTICA F3E:',
    JSON.stringify(d, null, 2)
  );

  assert.equal(d.tentato, true);
  assert.equal(d.adottato, true);

  assert.equal(
    d.motivo,
    'COPERTURA_MIGLIORATA'
  );

  const idsFinali = verificaAssegnazioni(
    piano,
    'PIANO DISAGGREGAZIONE CATEGORIA'
  );

  assert.ok(idsFinali.size >= 19);
  assert.ok(idsFinali.size <= 20);

  assert.deepEqual(d.perse, []);

  const idsOriginali =
    pianoOriginale.missioni.flatMap(
      m => m.gruppi.flatMap(
        g => g.prenotazioni.map(String)
      )
    );

  for (const id of idsOriginali) {

    assert.ok(
      idsFinali.has(id),
      'PRENOTAZIONE ORIGINALE PERSA: ' + id
    );
  }

  const diag =
    d.catalogo.disaggregazioneSelettiva;

  assert.equal(diag.gruppiFiltrati, 0);

  assert.equal(
    diag.gruppiInteramenteIncompatibili,
    0
  );

  assert.equal(
    diag.gruppiRidottiASingolo,
    0
  );

  assert.deepEqual(
    diag.prenotazioniEscluse,
    []
  );

  assert.equal(
    d.catalogo.prenotazioniTotali,
    20
  );

  assert.equal(
    d.catalogo.prenotazioniCoperte,
    20
  );

  assert.deepEqual(
    d.catalogo.prenotazioniSenzaServizi,
    []
  );

  const validazione = d.catalogo.validazioni.find(
    v => v.chiave === JSON.stringify(
      ['13', '14', '15']
    )
  );

  assert.ok(validazione);

  assert.equal(
    validazione.stato,
    'COMPLETATO'
  );

  assert.deepEqual(
    [...validazione.prenotazioniCompatibili].sort(),
    ['13', '14', '15']
  );

  assert.deepEqual(
    validazione.prenotazioniEscluse,
    []
  );

  assert.equal(
    validazione.partizioniGenerate,
    2
  );

  assert.equal(
    validazione.sottogruppiValidi,
    4
  );

  assert.equal(
    piano.audit?.missioniRicostruiteVerificate,
    true
  );

  const audit = validaMissioniNcc({
    missioni: piano.missioni,
    prenotazioni: rows,
    veicoli,
    verificaAttiva
  });

  assert.equal(audit.valido, true);

  assert.equal(
    audit.prenotazioniVerificate,
    idsFinali.size
  );

  assert.equal(
    audit.caricoRealeVerificato,
    true
  );

  assert.equal(
    audit.restrizioniOriginaliVerificate,
    true
  );

  assert.equal(
    JSON.stringify({
      pianoOriginale,
      aggregazione,
      rows,
      veicoli,
      parametri
    }),
    snapshot
  );

  assert.equal(
    JSON.stringify(scenario),
    prima
  );

  assert.equal(stats.geocodingAutonomo, 0);

  assert.equal(
    stats.elementiHTTP,
    stats.elementiAutorizzati
  );

  assert.equal(
    routing.diagnostica().interrotta,
    false
  );

  assert.equal(
    routing.diagnostica().budgetEsaurito,
    false
  );

  console.log('NESSUNA ESCLUSIONE INDIVIDUALE: OK');
  console.log('CATALOGO 20/20: OK');
  console.log('DISAGGREGAZIONE PER CATEGORIA: OK');
  console.log('AUDIT INDIPENDENTE: OK');
  console.log('INPUT INALTERATI: OK');

  console.log('RISULTATO F3E:', {
    prenotazioni: idsFinali.size,
    recuperate: d.recuperate,
    perse: d.perse,
    adottato: d.adottato,
    elementiRouting: stats.elementiHTTP
  });

  console.log(
    'TEST DISAGGREGAZIONE CATEGORIA SUPERATO'
  );

} finally {

  controller.abort();
}
