// NCC_TEST_PERDITA_COPERTURA_V2902E2F3F2
// NCC_TEST_FALLBACK_V2902E2F3F1\n
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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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
  13, 14, 15, 19, 20
]) {
  restrizioniPerId.set(String(id), ['minivan']);
}

for (const id of [16, 17, 18]) {
  restrizioniPerId.set(String(id), ['berlina']);
}

const rows = rowsStoriche.map(r => ({
  ...structuredClone(r),

  origineTipiVeicoloAmmessi:
    structuredClone(
      restrizioniPerId.get(String(r.id)) ?? null
    ),

  destinazioneTipiVeicoloAmmessi:
    null
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

const deadline = Date.now() + 180000;

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


  // NCC_TEST_FALLBACK_V2902E2F3F1

  const percorsoOriginale = path.resolve(
    'services/ncc-ottimizzazione-ibrida.service.js'
  );

  const bytesOriginali =
    fs.readFileSync(percorsoOriginale);

  const sorgente = bytesOriginali
    .toString('utf8')
    .replace(/\r\n/g, '\n');

  const ancoraggio =
    "  fase = 'AUDIT_MISSIONI_RICOSTRUITE';";

  assert.equal(
    sorgente.split(ancoraggio).length,
    2,
    'ANCORAGGIO ORCHESTRATORE NON UNIVOCO'
  );


  const casi = [

    {
      nome: 'F6_PERDITA_COPERTURA_ORIGINALE',

      perditaCopertura: true,

      codice: `
        assert.equal(originali.size, 17);
        assert.ok(originali.has('5'));
        assert.equal(idsPiano(candidato).size, 20);

        const m = candidato.missioni.find(
          m => m.gruppi.some(
            g => g.prenotazioni.map(String)
              .includes('5')
          )
        );

        assert.ok(m);

        const g = m.gruppi.find(
          g => g.prenotazioni.map(String)
            .includes('5')
        );

        assert.deepEqual(
          g.prenotazioni.map(String).sort(),
          ['4', '5']
        );

        const r = prenotazioniOriginali.find(
          r => String(r.id) === '5'
        );

        assert.ok(r);

        const pax = Number(r.passeggeri);

        assert.equal(pax, 1);

        assert.equal(g.passeggeri, 4);
        assert.equal(g.piccoPasseggeri, 4);

        assert.equal(
          g.itinerario.fermate.length,
          2
        );

        g.prenotazioni = g.prenotazioni.filter(
          id => String(id) !== '5'
        );

        g.passeggeri -= pax;
        g.piccoPasseggeri -= pax;

        g.itinerario.piccoPasseggeri -= pax;

        for (const f of g.itinerario.fermate) {

          assert.ok(
            f.prenotazioni.map(String)
              .includes('5')
          );

          f.prenotazioni =
            f.prenotazioni.filter(
              id => String(id) !== '5'
            );

          if (f.tipo === 'salita') {

            assert.equal(
              f.passeggeriABordo,
              4
            );

            f.passeggeriABordo -= pax;

          } else {

            assert.equal(f.tipo, 'discesa');

            assert.equal(
              f.passeggeriABordo,
              0
            );
          }
        }

        g.chiave = JSON.stringify(
          g.prenotazioni.map(String).sort()
        );

        g.riempimento = Math.round(
          g.piccoPasseggeri / g.posti * 100
        );

        const ricavo = Number(
          r.prezzo_centesimi
        );

        assert.ok(
          Number.isSafeInteger(ricavo) &&
          ricavo >= 0
        );

        g.economia.ricaviCentesimi -= ricavo;

        g.economia.margineCentesimi =
          g.economia.ricaviCentesimi -
          g.economia.costoCentesimi;

        g.economia.kmIndividuali =
          g.itinerario.km;

        g.economia.kmRisparmiati = 0;

        m.passeggeri = m.gruppi.reduce(
          (totale, gruppo) =>
            totale + gruppo.passeggeri,
          0
        );

        m.piccoPasseggeri = Math.max(
          ...m.gruppi.map(
            gruppo => gruppo.piccoPasseggeri
          )
        );

        m.economia.ricaviCentesimi -= ricavo;

        m.economia.margineCentesimi =
          m.economia.ricaviCentesimi -
          m.economia.costoCentesimi;

        assert.equal(
          idsPiano(candidato).size,
          19
        );

        assert.equal(
          idsPiano(candidato).has('5'),
          false
        );

        console.log(
          'CANDIDATO RIDOTTO:',
          {
            prenotazioni: 19,
            rimossa: '5',
            passeggeriGruppo: g.passeggeri,
            passeggeriMissione: m.passeggeri,
            piccoMissione: m.piccoPasseggeri
          }
        );
      `
    }

  ];

  const risultati = [];

  function verificaInput() {

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

    assert.deepEqual(
      fs.readFileSync(percorsoOriginale),
      bytesOriginali
    );
  }

  for (const caso of casi) {

    verificaAttiva();

    const temporaneo = path.join(
      path.dirname(percorsoOriginale),
      '.ncc-test-fallback-' +
        randomUUID() + '.mjs'
    );

    let alterazioneEseguita = false;

    const avvio = Date.now();

    try {

      const modificato = sorgente.replace(
        ancoraggio,

        ancoraggio +
        '\n' +
        caso.codice +
        '\n' +
        '  console.log("INIEZIONE F3F ESEGUITA");' +
        '\n' +
        '  segnalaIniezioneF3F();' +
        '\n'
      );

      const sorgenteTest =
        'let callbackIniezioneF3F = () => {};\n' +
        'export function registraIniezioneF3F(fn) {' +
        ' callbackIniezioneF3F = fn; }\n' +
        'function segnalaIniezioneF3F() {' +
        ' callbackIniezioneF3F(); }\n' +
        modificato;

      fs.writeFileSync(
        temporaneo,
        sorgenteTest,
        { encoding: 'utf8', flag: 'wx' }
      );

      const modulo = await import(
        pathToFileURL(temporaneo).href
      );

      modulo.registraIniezioneF3F(() => {
        alterazioneEseguita = true;
      });

      const esegui = () =>
        modulo.ottimizzaIbridoNcc({
          ...input,
          abilitato: true
        });

      assert.equal(
        modulo.diagnosticaConcorrenzaCpsatNcc()
          .attive,
        0
      );

      let risultato = null;

      if (caso.lease) {

        await assert.rejects(
          esegui,
          /TEST_LEASE_PERSO/
        );

      } else {

        risultato = await esegui();

        const d = risultato.diagnostica;

        assert.equal(d.tentato, true);

        if (caso.positivo) {

          assert.equal(d.adottato, true);

          assert.equal(
            d.motivo,
            'COPERTURA_MIGLIORATA'
          );

          assert.equal(
            verificaAssegnazioni(
              risultato.piano,
              caso.nome
            ).size,
            20
          );

          assert.equal(
            risultato.piano.audit
              ?.missioniRicostruiteVerificate,
            true
          );

          assert.deepEqual(d.perse, []);

        } else if (caso.perditaCopertura) {

          console.log(
            'DIAGNOSTICA F6:',
            JSON.stringify({
              tentato: d.tentato,
              adottato: d.adottato,
              motivo: d.motivo,
              prenotazioniCandidato:
                d.prenotazioniCandidato,
              recuperate: d.recuperate,
              perse: d.perse,
              auditMissioni: d.auditMissioni
            }, null, 2)
          );

          assert.equal(d.adottato, false);

          assert.equal(
            d.motivo,
            'PERDITA_PRENOTAZIONI_ORIGINALI'
          );

          assert.equal(
            d.prenotazioniCandidato,
            19
          );

          assert.deepEqual(
            d.perse,
            ['5']
          );

          assert.deepEqual(
            [...d.recuperate].sort(),
            ['13', '14', '15']
          );

          assert.equal(
            d.auditMissioni?.valido,
            true
          );

          assert.equal(
            d.auditMissioni
              ?.prenotazioniVerificate,
            19
          );

          assert.equal(
            d.auditMissioni
              ?.caricoRealeVerificato,
            true
          );

          assert.equal(
            d.auditMissioni
              ?.restrizioniOriginaliVerificate,
            true
          );

          assert.equal(
            risultato.piano,
            pianoOriginale
          );

          const idsFinali =
            verificaAssegnazioni(
              risultato.piano,
              caso.nome
            );

          assert.equal(idsFinali.size, 17);

          assert.equal(
            idsFinali.has('5'),
            true
          );

          console.log(
            'AUDIT CANDIDATO 19/20: OK'
          );

          console.log(
            'PROTEZIONE PRENOTAZIONE 5: OK'
          );

          console.log(
            'RIPRISTINO ORIGINALE 17/20: OK'
          );

        } else {

          assert.equal(d.adottato, false);

          assert.equal(
            risultato.piano,
            pianoOriginale
          );

          assert.equal(
            d.motivo,
            'FALLBACK_CP_SAT'
          );

          assert.equal(
            d.fallback?.attivato,
            true
          );

          assert.equal(
            d.fallback?.fase,
            'AUDIT_MISSIONI_RICOSTRUITE'
          );

          assert.equal(
            verificaAssegnazioni(
              risultato.piano,
              caso.nome
            ).size,
            17
          );
        }
      }

      assert.equal(
        alterazioneEseguita,
        true,
        'PUNTO DI INIEZIONE NON RAGGIUNTO'
      );

      const concorrenza =
        modulo.diagnosticaConcorrenzaCpsatNcc();

      assert.equal(concorrenza.attive, 0);

      assert.equal(
        concorrenza.disponibili,
        concorrenza.limite
      );

      verificaInput();

      assert.equal(
        stats.geocodingAutonomo,
        0
      );

      assert.equal(
        stats.elementiHTTP,
        stats.elementiAutorizzati
      );

      risultati.push({
        test: caso.nome,
        esito: 'PASS',
        adottato:
          risultato?.diagnostica.adottato ?? false,
        motivo:
          risultato?.diagnostica.motivo ??
          'LEASE_PERSO',
        slotLiberato: true,
        durataMs: Date.now() - avvio
      });

      console.log('PASS:', caso.nome);

    } finally {

      if (fs.existsSync(temporaneo)) {
        fs.unlinkSync(temporaneo);
      }
    }
  }

  // Verifica finale del vero orchestratore.

  const finale = await ottimizzaIbridoNcc({
    ...input,
    abilitato: true
  });

  assert.equal(
    finale.diagnostica.adottato,
    true
  );

  assert.equal(
    verificaAssegnazioni(
      finale.piano,
      'ORCHESTRATORE PRODUTTIVO INTEGRO'
    ).size,
    20
  );

  verificaInput();

  assert.equal(
    stats.geocodingAutonomo,
    0
  );

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

  console.table(risultati);

  console.log(
    'SCENARI SUPERATI:',
    risultati.length,
    '/',
    casi.length
  );

  console.log('SLOT CP-SAT LIBERATI: OK');
  console.log('INPUT INALTERATI: OK');
  console.log('SORGEN﻿TE PRODUTTIVO INALTERATO: OK');
  console.log('ROUTING INTEGRO: OK');
  console.log('ORCHESTRATORE ORIGINALE 20/20: OK');

  console.log(
    'V290.2E.2F.3F.2 TEST SUPERATI'
  );

} finally {

  controller.abort();
}
