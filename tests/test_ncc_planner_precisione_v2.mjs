
import assert from 'node:assert/strict';

import {
  simulazioneNccV26
} from '../services/ncc-import-planner.service.js';

import {
  creaRoutingNcc,
  distanzaGeografica
} from '../services/ncc-routing-matrix.service.js';

const giorno = '2026-11-27';

const riferimento = Date.parse(
  giorno + 'T00:00:00+01:00'
);

const futuro = new Date(
  Date.now() + 3600000
).toISOString();

const passato = new Date(
  Date.now() - 3600000
).toISOString();

const luoghi = {
  Lecce: [40.3522, 18.1755],
  Brindisi: [40.6384, 17.9460],
  Maglie: [40.1206, 18.2978],
  Otranto: [40.1478, 18.4865],
  Aeroporto: [40.6576, 17.9470]
};

let superati = 0;

async function test(nome, fn) {
  await fn();
  superati++;
  console.log('PASS:', nome);
}

function punto(ruolo, nome, stato) {
  const [lat, lon] = luoghi[nome];

  return {
    [ruolo]: nome,
    [ruolo + '_stato_geo']: stato,
    [ruolo + '_lat']: lat,
    [ruolo + '_lon']: lon,
    [ruolo + '_verificata_il']: passato,
    [ruolo + '_geo_scade_il']: futuro,
    [ruolo + '_fonte_geo']: 'TEST'
  };
}

function prenotazione(id, extra = {}) {
  return {
    id,
    prelievo_il: new Date(
      riferimento + (480 + id) * 60000
    ).toISOString(),

    passeggeri: 1,
    bagagli: 0,
    prezzo_centesimi: 5000,

    ...punto(
      'origine',
      'Lecce',
      'VALIDATO_AUTO'
    ),

    ...punto(
      'destinazione',
      'Brindisi',
      'VALIDATO_AUTO'
    ),

    ...extra
  };
}

async function esegui(rows, opzioni = {}) {

  const controller = new AbortController();

  const stats = {
    query: 0,
    resolver: 0,
    autorizzazioniGeo: 0,
    elementiRouting: 0,
    richiesteRouting: 0,
    geocodingAutonomo: 0,
    queryCatalogo: 0
  };

  const veicoli = [{
    id: 1,
    posti_totali: 16,
    marca: 'TEST',
    modello: 'MINIBUS',
    tipo: 'minibus',
    targa: 'TEST001',
    localita: 'Lecce',
    lat: luoghi.Lecce[0],
    lon: luoghi.Lecce[1]
  }];

  const parametri = {
    tolleranzaMinuti: 20,
    obiettivoRiempimento: 75,
    prioritaVolo: true,
    costiVeicoli: { 1: 0.75 },
    attesaMassimaMinuti: 120,
    durataMassimaMissioneMinuti: 720
  };

  function verificaAttiva() {
    controller.signal.throwIfAborted();
  }

  const pool = {
    // NCC_TEST_CATALOGO_V2902E2D2A
    async query(sql, params) {
      verificaAttiva();

      stats.query++;

      if (sql.includes(
        'FROM public.ncc_parametri_pianificatore'
      )) {
        return { rows: [parametri] };
      }

      if (sql.includes(
        'FROM public.ncc_prenotazioni_esterne p'
      )) {

        // Verifica che la patch sia realmente
        // integrata nella query del planner.

        for (const ruolo of [
          'origine',
          'destinazione'
        ]) {
          for (const campo of [
            'stato_geo',
            'lat',
            'lon',
            'verificata_il',
            'geo_scade_il',
            'punto_operativo_id',
            'fonte_geo',
            'place_id',
            'dettaglio_geo'
          ]) {
            assert.ok(
              sql.includes(
                'p.' + ruolo + '_' + campo
              ),
              'CAMPO GEO MANCANTE: ' +
              ruolo + '_' + campo
            );
          }
        }

        assert.ok(
          sql.includes('NOT EXISTS')
        );

        return { rows };
      }

      if (sql.includes(
        'FROM public.veicolo'
      )) {
        return { rows: veicoli };
      }

      if (sql.includes('EXTRACT(EPOCH')) {
        return {
          rows: [{ ms: riferimento }]
        };
      }

      if (sql.includes(
        'FROM public.ncc_gruppi_approvati'
      )) {
        return { rows: [] };
      }

      if (sql.includes(
        'catalogo_luoghi_alias'
      )) {
        stats.queryCatalogo++;

        const alias = params?.[0];

        const riconosciuto =
          alias === 'luogo operativo test' ||
          (
            opzioni.catalogoRiconosciuto === true &&
            alias === 'lecce'
          );

        if (!riconosciuto) {
          return { rows: [] };
        }

        return {
          rows: [{
            id: '5',
            codice: 'TEST',
            nome: 'Luogo test',
            attivo:
              opzioni.catalogoAttivo !== false
          }]
        };
      }

      if (sql.includes(
        'catalogo_punti_operativi'
      )) {
        stats.queryCatalogo++;

        return {
          rows: [{
            id: '10',
            lat: luoghi.Lecce[0],
            lon: luoghi.Lecce[1],
            geo_scade_il: null,
            tipi_veicolo_ammessi:
              opzioni.tipiVeicoloAmmessi === undefined
                ? null
                : opzioni.tipiVeicoloAmmessi
          }]
        };
      }

      throw new Error(
        'QUERY NON PREVISTA: ' + sql
      );
    }
  };

  const manager = {
    async esegui(operatore, lavoro) {
      try {
        const risultato = await lavoro({
          operatoreId: operatore,
          simulazioneId: 'TEST_V290',
          signal: controller.signal,
          verificaAttiva,

          async autorizzaRouting(n) {
            verificaAttiva();

            const autorizzati = Math.max(
              0,
              Math.min(
                n,
                1000 - stats.elementiRouting
              )
            );

            stats.elementiRouting +=
              autorizzati;

            return {
              consentito: autorizzati > 0,
              elementiAutorizzati: autorizzati
            };
          },

          async autorizzaGeografia(tipo) {
            verificaAttiva();

            stats.autorizzazioniGeo++;

            return {
              consentito: true,
              elementiAutorizzati: 1,
              tipo
            };
          }
        });

        verificaAttiva();

        return {
          consentito: true,
          simulazioneId: 'TEST_V290',
          risultato,
          sessione: { simulata: true }
        };

      } finally {
        controller.abort(
          new Error('NCC_SESSIONE_CHIUSA')
        );
      }
    }
  };

  function creaGeografia(db, { guard }) {
    return {
      guard,

      async validaPunto(nome, ruolo) {
        guard.verifica();

        stats.resolver++;

        if (opzioni.perditaLease) {
          controller.abort(
            new Error('NCC_LEASE_PERSO')
          );

          guard.verifica();
        }

        if (
          opzioni.catalogoAttivo === false &&
          nome === 'Lecce'
        ) {
          return {
            stato: 'DA_VERIFICARE',
            valido: false,
            utilizzabileSimulazione: false,
            indicativo: false
          };
        }

        const coord = luoghi[nome];

        if (!coord) {
          return {
            stato: 'NON_TROVATO',
            utilizzabileSimulazione: false
          };
        }

        const consentito =
          await guard.autorizza('GEOCODING');

        if (!consentito) {
          return {
            stato: 'DA_ELABORARE',
            utilizzabileSimulazione: false
          };
        }

        guard.verifica();

        const indicativo =
          nome === 'Aeroporto' &&
          opzioni.aeroportoIndicativo === true;

        return {
          stato: indicativo
            ? 'DA_VERIFICARE'
            : 'VALIDATO_AUTO',

          valido: !indicativo,
          utilizzabileSimulazione: true,
          indicativo,
          approvabile: false,
          lat: coord[0],
          lon: coord[1]
        };
      },

      diagnostica() {
        return guard.diagnostica();
      }
    };
  }

  function creaRouting(config) {

    assert.equal(
      config.autorizzazioneRigorosa,
      true
    );

    assert.equal(
      config.richiediAutorizzazione,
      true
    );

    return creaRoutingNcc({
      ...config,

      apiKey: 'TEST',

      locate: async () => {
        stats.geocodingAutonomo++;

        throw new Error(
          'GEOCODING AUTONOMO VIETATO'
        );
      },

      fetchImpl: async url => {
        verificaAttiva();

        stats.richiesteRouting++;

        const u = new URL(url);

        const origine =
          u.searchParams.get('origins');

        const destinazioni =
          u.searchParams.get('destinations')
            .split('|');

        function coord(s) {
          const [lat, lon] =
            s.split(',').map(Number);

          assert.ok(Number.isFinite(lat));
          assert.ok(Number.isFinite(lon));

          return { lat, lon };
        }

        const a = coord(origine);

        const elements = destinazioni.map(d => {
          const b = coord(d);

          const km =
            distanzaGeografica(a, b) * 1.25;

          return {
            status: 'OK',

            distance: {
              value: Math.round(km * 1000)
            },

            duration: {
              value: Math.ceil(
                km / 55 * 3600
              )
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
  }

  const r = await simulazioneNccV26(
    pool,
    1,
    giorno,
    {
      manager,
      creaGeografia,
      creaRouting,
      schedulazioneTemporale: true,
      reinserimentoDinamico: true,
      aggregazioneAdattiva: true,
      cpsatAdattivo: false
    }
  );

  assert.equal(r.approvabile, false);

  assert.equal(
    r.audit.univocitaPrenotazioni,
    true
  );

  assert.equal(
    stats.geocodingAutonomo,
    0
  );

  assert.equal(
    r.totalePrenotazioni,
    rows.length
  );

  assert.equal(
    r.geografia.utilizzabili +
    r.geografia.escluse,
    rows.length
  );

  const d =
    r.geografia.diagnostica.riutilizzo;

  assert.ok(d, 'DIAGNOSTICA RIUTILIZZO ASSENTE');

  assert.equal(
    d.nuoveElaborazioni,
    stats.resolver
  );

  return { r, d, stats };
}


const manualeStrada = {
  origine: 'Via Degli Ammirati, Lecce',
  origine_stato_geo: 'VALIDATO_MANUALE',
  origine_fonte_geo: 'GOOGLE_PLACES_CONFERMATO',
  origine_dettaglio_geo: {
    precisione: 'STRADA',
    posizioneIndicativa: true,
    numeroCivicoMancante: true,
    numeroCivicoNonRiconosciuto: false,
    civicoVerificatoDaGoogle: false,
    confermatoDaOperatore: true,
    operatoreId: '1'
  }
};

await test(
  'Posizione stradale accettata inclusa nel planner',
  async () => {
    const { r, d, stats } = await esegui([
      prenotazione(1, manualeStrada)
    ]);

    assert.equal(d.riutilizzatiManuali, 1);
    assert.equal(stats.resolver, 0);
    assert.equal(stats.autorizzazioniGeo, 0);
    assert.equal(r.geografia.utilizzabili, 1);
    assert.equal(r.geografia.escluse, 0);

    assert.ok(r.proposte.length > 0);
    assert.ok(r.missioni.length > 0);

    assert.ok(
      r.proposte.every(
        p => p.geografiaIndicativa !== true
      ),
      'Posizione accettata classificata come provvisoria'
    );
  }
);

await test(
  'Posizione stradale scaduta esclusa dal planner',
  async () => {
    const { r, d, stats } = await esegui([
      prenotazione(1, {
        ...manualeStrada,
        origine_geo_scade_il: passato
      })
    ]);

    assert.equal(d.manualiDaRiconfermare, 1);
    assert.equal(stats.resolver, 0);
    assert.equal(r.geografia.utilizzabili, 0);
    assert.equal(r.geografia.escluse, 1);

    assert.equal(
      r.geografia.dettaglioEscluse[0].origine,
      'MANUALE_DA_RICONFERMARE'
    );
  }
);

await test(
  'Consenso stradale non trasferito ad altra prenotazione',
  async () => {
    const { r, d, stats } = await esegui([
      prenotazione(1, manualeStrada),

      prenotazione(2, {
        origine: manualeStrada.origine,
        origine_stato_geo: 'DA_ELABORARE',
        origine_lat: null,
        origine_lon: null,
        origine_dettaglio_geo: null
      })
    ]);

    assert.equal(d.riutilizzatiManuali, 1);
    assert.equal(stats.resolver, 1);
    assert.equal(r.geografia.utilizzabili, 1);
    assert.equal(r.geografia.escluse, 1);

    assert.equal(
      String(r.geografia.dettaglioEscluse[0].id),
      '2'
    );
  }
);

console.log('TEST PLANNER PRECISIONE V2:', superati, '/ 3');
console.log('TEST COMPLETATI');
