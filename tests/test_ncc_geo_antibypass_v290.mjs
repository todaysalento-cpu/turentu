
import assert from 'node:assert/strict';

import {
  statoPuntoGeograficoNcc
} from '../services/ncc-geografia-stato.service.js';

import {
  creaRiutilizzoGeograficoNcc
} from '../services/ncc-geografia-riutilizzo.service.js';

let superati = 0;

async function test(nome, fn) {
  await fn();
  superati++;
  console.log('PASS:', nome);
}

function prenotazione(extra = {}) {
  return {
    id: '1',
    origine: 'Luogo operativo test',
    origine_stato_geo: 'VALIDATO_AUTO',
    origine_lat: 40.35,
    origine_lon: 18.17,
    origine_verificata_il:
      new Date(Date.now() - 3600000).toISOString(),
    origine_geo_scade_il:
      new Date(Date.now() + 3600000).toISOString(),
    origine_fonte_geo: 'GOOGLE_GEOCODING',
    origine_punto_operativo_id: null,
    ...extra
  };
}

function ambiente(opzioni = {}) {
  const controller = new AbortController();

  const stats = {
    alias: 0,
    punti: 0,
    geocoding: 0
  };

  const guard = {
    signal: controller.signal,

    verifica() {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
    },

    async attendi(fn) {
      this.verifica();
      const risultato = await fn();
      this.verifica();
      return risultato;
    }
  };

  const db = {
    async query(sql, params) {
      guard.verifica();

      if (opzioni.perditaLease) {
        controller.abort(
          new Error('NCC_LEASE_PERSO')
        );

        guard.verifica();
      }

      if (sql.includes('catalogo_luoghi_alias')) {
        stats.alias++;

        if (
          opzioni.assente ||
          params[0] !== 'luogo operativo test'
        ) {
          return { rows: [] };
        }

        if (opzioni.ambiguo) {
          return {
            rows: [
              { id: '5', attivo: true },
              { id: '6', attivo: true }
            ]
          };
        }

        return {
          rows: [{
            id: '5',
            attivo: !opzioni.inattivo
          }]
        };
      }

      if (
        sql.includes('catalogo_punti_operativi')
      ) {
        stats.punti++;

        if (opzioni.senzaPunti) {
          return { rows: [] };
        }

        const punto = {
          id: '10',
          lat: 40.35,
          lon: 18.17,
          geo_scade_il: null,
          tipi_veicolo_ammessi: ['minivan'],
          ...opzioni.punto
        };

        if (opzioni.vincoloMancante) {
          delete punto.tipi_veicolo_ammessi;
        }

        return { rows: [punto] };
      }

      throw new Error('Query inattesa: ' + sql);
    }
  };

  const geografia = {
    async validaPunto() {
      stats.geocoding++;

      throw new Error(
        'Fallback geografico non consentito'
      );
    }
  };

  const motore = creaRiutilizzoGeograficoNcc(
    db,
    geografia,
    guard
  );

  return { db, motore, stats };
}

const manuale = {
  origine_stato_geo: 'VALIDATO_MANUALE'
};

// 1

await test(
  'Automatico ordinario senza restrizioni',
  async () => {
    const a = ambiente({ assente: true });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(r.valido, true);
    assert.equal(r.tipiVeicoloAmmessi, null);
    assert.equal(a.stats.geocoding, 0);
  }
);

// 2

await test(
  'Automatico coincidente acquisisce vincoli',
  async () => {
    const a = ambiente();

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(r.valido, true);
    assert.equal(r.puntoOperativoId, '10');
    assert.deepEqual(
      r.tipiVeicoloAmmessi,
      ['minivan']
    );
  }
);

// 3

await test(
  'Manuale coincidente acquisisce vincoli',
  async () => {
    const a = ambiente();

    const r = await a.motore.valida(
      prenotazione(manuale),
      'origine'
    );

    assert.equal(r.valido, true);
    assert.equal(r.stato, 'VALIDATO_MANUALE');
    assert.equal(r.lat, 40.35);
    assert.equal(r.puntoOperativoId, '10');
    assert.deepEqual(
      r.tipiVeicoloAmmessi,
      ['minivan']
    );
  }
);

// 4

await test(
  'Automatico non coincidente bloccato',
  async () => {
    const a = ambiente({
      punto: { lat: 40.36 }
    });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(
      r.stato,
      'CATALOGO_DA_AGGIORNARE'
    );

    assert.equal(
      r.utilizzabileSimulazione,
      false
    );

    assert.equal(a.stats.geocoding, 0);
  }
);

// 5

await test(
  'Manuale non coincidente da riconfermare',
  async () => {
    const a = ambiente({
      punto: { lat: 40.36 }
    });

    const r = await a.motore.valida(
      prenotazione(manuale),
      'origine'
    );

    assert.equal(
      r.stato,
      'MANUALE_DA_RICONFERMARE'
    );

    assert.equal(r.valido, false);
    assert.equal(a.stats.geocoding, 0);
  }
);

// 6

await test(
  'Catalogo inattivo blocca automatico',
  async () => {
    const a = ambiente({ inattivo: true });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(
      r.stato,
      'CATALOGO_NON_DISPONIBILE'
    );

    assert.equal(r.valido, false);
    assert.equal(a.stats.geocoding, 0);
  }
);

// 7

await test(
  'Catalogo inattivo blocca manuale',
  async () => {
    const a = ambiente({ inattivo: true });

    const r = await a.motore.valida(
      prenotazione(manuale),
      'origine'
    );

    assert.equal(
      r.stato,
      'MANUALE_DA_RICONFERMARE'
    );

    assert.equal(r.valido, false);
    assert.equal(a.stats.geocoding, 0);
  }
);

// 8

await test(
  'Catalogo ambiguo senza fallback',
  async () => {
    const a = ambiente({ ambiguo: true });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'AMBIGUO');
    assert.equal(a.stats.geocoding, 0);
  }
);

// 9

await test(
  'Nessun punto operativo disponibile',
  async () => {
    const a = ambiente({ senzaPunti: true });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(r.valido, false);

    assert.equal(
      r.motivo,
      'PUNTO_NON_DISPONIBILE'
    );

    assert.equal(a.stats.geocoding, 0);
  }
);

// 10

await test(
  'Vincolo mancante non equivale a NULL',
  async () => {
    const a = ambiente({
      vincoloMancante: true
    });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.deepEqual(
      r.tipiVeicoloAmmessi,
      []
    );
  }
);

// 11

await test(
  'Vincolo malformato non autorizza veicoli',
  async () => {
    const a = ambiente({
      punto: {
        tipi_veicolo_ammessi: 'minivan'
      }
    });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.deepEqual(
      r.tipiVeicoloAmmessi,
      []
    );
  }
);

// 12

await test(
  'NULL esplicito mantiene accesso libero',
  async () => {
    const a = ambiente({
      punto: {
        tipi_veicolo_ammessi: null
      }
    });

    const r = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.equal(r.tipiVeicoloAmmessi, null);
  }
);

// 13

await test(
  'Cache catalogo deduplica dieci prenotazioni',
  async () => {
    const a = ambiente();

    for (let i = 0; i < 10; i++) {
      const r = await a.motore.valida(
        prenotazione({ id: String(i + 1) }),
        'origine'
      );

      assert.equal(r.valido, true);
    }

    assert.equal(a.stats.alias, 1);
    assert.equal(a.stats.punti, 1);

    const d = a.motore.diagnostica();

    assert.equal(d.controlliCatalogo, 1);
    assert.equal(d.cacheHitCatalogo, 9);
    assert.equal(d.vincoliCatalogoRiutilizzati, 10);
  }
);

// 14

await test(
  'Nuova simulazione legge vincoli aggiornati',
  async () => {
    const a = ambiente();

    const b = ambiente({
      punto: {
        tipi_veicolo_ammessi: ['bus']
      }
    });

    const r1 = await a.motore.valida(
      prenotazione(),
      'origine'
    );

    const r2 = await b.motore.valida(
      prenotazione(),
      'origine'
    );

    assert.deepEqual(
      r1.tipiVeicoloAmmessi,
      ['minivan']
    );

    assert.deepEqual(
      r2.tipiVeicoloAmmessi,
      ['bus']
    );
  }
);

// 15

await test(
  'Perdita lease durante controllo catalogo',
  async () => {
    const a = ambiente({
      perditaLease: true
    });

    await assert.rejects(
      () => a.motore.valida(
        prenotazione(),
        'origine'
      ),
      /NCC_LEASE_PERSO/
    );

    assert.equal(a.stats.geocoding, 0);
  }
);

// 16

await test(
  'Stato geografico coerente con blocco planner',
  async () => {
    const a = ambiente({ inattivo: true });

    const r = await statoPuntoGeograficoNcc(
      a.db,
      prenotazione(),
      'origine'
    );

    assert.equal(r.utilizzabile, false);

    assert.equal(
      r.statoEffettivo,
      'CATALOGO_NON_DISPONIBILE'
    );
  }
);

console.log(
  '\nTEST ANTI BYPASS SUPERATI:',
  superati,
  '/ 16'
);

console.log(
  'V290.2E.2D.3 TEST COMPLETATI'
);
