
import {
  ottimizzaIbridoNcc
} from '../services/ncc-ottimizzazione-ibrida.service.js';


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

// NCC_FIXTURE_V2902E2F2C2A

// Adeguamento del benchmark sintetico storico.
// Nessuna modifica al dataset originale.

const {
  rows: rowsStoriche,
  veicoli: veicoliStorici,
  parametri
} = scenario.dataset;

const rows = rowsStoriche.map(r => ({
  ...structuredClone(r),

  origineTipiVeicoloAmmessi:
    Object.hasOwn(r, 'origineTipiVeicoloAmmessi')
      ? structuredClone(r.origineTipiVeicoloAmmessi)
      : null,

  destinazioneTipiVeicoloAmmessi:
    Object.hasOwn(r, 'destinazioneTipiVeicoloAmmessi')
      ? structuredClone(r.destinazioneTipiVeicoloAmmessi)
      : null
}));

const veicoli = veicoliStorici.map(v => ({
  ...structuredClone(v),

  tipo: Object.hasOwn(v, 'tipo')
    ? v.tipo
    : null
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

  // TEST 4: recupero effettivo CP-SAT.

  const avvio = Date.now();

  const ibrido =
    await ottimizzaIbridoNcc({
      ...input,
      abilitato: true
    });

  const piano = ibrido.piano;
  const d = ibrido.diagnostica;

  assert.equal(d.tentato, true);
  assert.equal(d.adottato, true);

  assert.equal(
    d.motivo,
    'COPERTURA_MIGLIORATA'
  );

  assert.equal(
    d.prenotazioniOriginali,
    17
  );

  assert.equal(
    d.prenotazioniCandidato,
    20
  );

  assert.equal(d.recuperate.length, 3);
  assert.equal(d.perse.length, 0);

  assert.equal(
    piano.riepilogo
      .prenotazioniAssegnate,
    20
  );

  assert.equal(
    piano.riepilogo
      .serviziNonAssegnati,
    0
  );

  assert.equal(
    piano.riepilogo.missioni,
    3
  );

  assert.equal(
    piano.riepilogo.veicoliUtilizzati,
    2
  );

  assert.equal(
    piano.riepilogo.passeggeri,
    36
  );

  assert.equal(
    piano.riepilogo.ricaviCentesimi,
    179118
  );

  assert.equal(
    piano.riepilogo.costoCentesimi,
    53146
  );

  assert.equal(
    piano.riepilogo.margineCentesimi,
    125972
  );

  assert.ok(
    Math.abs(
      piano.riepilogo.kmTotali -
      888.011
    ) < 1e-6
  );

  assert.equal(
    piano.approvabile,
    false
  );

  const ids = piano.missioni.flatMap(
    m => m.gruppi.flatMap(
      g => g.prenotazioni.map(String)
    )
  );

  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);

  assert.deepEqual(
    [...ids].sort(),
    rows.map(r => String(r.id)).sort()
  );

  const originali =
    pianoOriginale.missioni.flatMap(
      m => m.gruppi.flatMap(
        g => g.prenotazioni.map(String)
      )
    );

  for (const id of originali) {

    assert.ok(
      ids.includes(id),
      'PRENOTAZIONE ORIGINALE PERSA'
    );
  }

  console.log('CP-SAT IBRIDO: OK');

  console.log(
    'PRENOTAZIONI RECUPERATE:',
    d.recuperate
  );

  console.log(
    'PRENOTAZIONI PERSE:',
    d.perse
  );

  console.log(
    'DURATA IBRIDO MS:',
    Date.now() - avvio
  );

  // TEST 5: piano gia completo.
  // Non deve ripetere CP-SAT.

  const elementiDopo =
    stats.elementiHTTP;

  const completo =
    await ottimizzaIbridoNcc({
      ...input,
      abilitato: true,
      pianoOriginale: piano
    });

  assert.equal(completo.piano, piano);

  assert.equal(
    completo.diagnostica.motivo,
    'NESSUNA_ESCLUSIONE_RECUPERABILE'
  );

  assert.equal(
    completo.diagnostica.tentato,
    false
  );

  assert.equal(
    stats.elementiHTTP,
    elementiDopo
  );

  console.log('PIANO GIA COMPLETO: OK');

  // TEST 6: cancellazione sessione.

  await assert.rejects(
    () => ottimizzaIbridoNcc({
      ...input,
      abilitato: true,

      verificaAttiva() {
        throw Error('TEST_CANCELLAZIONE');
      }
    }),

    /TEST_CANCELLAZIONE/
  );

  console.log('CANCELLAZIONE: OK');

  // TEST 7: integrita degli input.

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

  console.log('INPUT INALTERATI: OK');

  // TEST 8: integrita routing.

  const routingFinale =
    routing.diagnostica();

  assert.equal(
    routingFinale.interrotta,
    false
  );

  assert.equal(
    routingFinale.budgetEsaurito,
    false
  );

  console.log('ROUTING INTEGRO: OK');

  console.table([
    {
      motore: 'V2.8.0',

      prenotazioni:
        pianoOriginale.riepilogo
          .prenotazioniAssegnate,

      missioni:
        pianoOriginale.missioni.length,

      km:
        pianoOriginale.riepilogo.kmTotali,

      costo:
        pianoOriginale.riepilogo
          .costoCentesimi / 100,

      margine:
        pianoOriginale.riepilogo
          .margineCentesimi / 100
    },

    {
      motore: 'V286g.2 IBRIDO',

      prenotazioni:
        piano.riepilogo
          .prenotazioniAssegnate,

      missioni: piano.missioni.length,

      km: piano.riepilogo.kmTotali,

      costo:
        piano.riepilogo
          .costoCentesimi / 100,

      margine:
        piano.riepilogo
          .margineCentesimi / 100
    }
  ]);

  const report =
    'ncc-ibrido-v286g2-' +
    Date.now() + '.json';

  fs.writeFileSync(
    report,

    JSON.stringify({
      versione: '2.8.6g.2',
      pianoOriginale,
      piano,
      diagnostica: d,
      stats,
      routingFinale
    }, null, 2)
  );

  console.log(
    'ELEMENTI HTTP:',
    stats.elementiHTTP
  );

  console.log(
    'STATISTICHE:',
    JSON.stringify(stats, null, 2)
  );

  console.log('REPORT:', report);

  console.log(
    'TEST V286g.2 IBRIDO SUPERATO'
  );

} finally {

  controller.abort();
}
