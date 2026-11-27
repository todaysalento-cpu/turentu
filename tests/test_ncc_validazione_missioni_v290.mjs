
import assert from 'node:assert/strict';

import {
  validaMissioniNcc
} from '../services/ncc-validazione-missioni.service.js';

function scenario() {
  return {
    prenotazioni: [
      {
        id: 1,
        passeggeri: 5,
        origineTipiVeicoloAmmessi: ['minivan'],
        destinazioneTipiVeicoloAmmessi: null
      },
      {
        id: 2,
        passeggeri: 3,
        origineTipiVeicoloAmmessi: null,
        destinazioneTipiVeicoloAmmessi: ['minivan']
      }
    ],

    veicoli: [
      {
        id: 10,
        tipo: 'minivan',
        posti_totali: 8
      }
    ],

    occupati: new Set(),

    missioni: [
      {
        giorno: '2026-11-27',
        veicoloId: 10,
        posti: 8,
        passeggeri: 8,
        piccoPasseggeri: 8,
        tipiVeicoloAmmessi: ['minivan'],

        logistica: {
          partenzaBase: '2026-11-27T07:30:00Z',
          arrivoBase: '2026-11-27T10:30:00Z'
        },

        gruppi: [
          {
            veicoloId: 10,
            posti: 8,
            prenotazioni: ['1', '2'],
            passeggeri: 8,
            piccoPasseggeri: 8,
            tipiVeicoloAmmessi: ['minivan'],

            inizio: '2026-11-27T08:00:00Z',
            fine: '2026-11-27T10:00:00Z',

            itinerario: {
              fermate: [
                {
                  tipo: 'salita',
                  orario: '2026-11-27T08:00:00Z',
                  prenotazioni: ['1'],
                  passeggeriABordo: 5
                },
                {
                  tipo: 'salita',
                  orario: '2026-11-27T08:30:00Z',
                  prenotazioni: ['2'],
                  passeggeriABordo: 8
                },
                {
                  tipo: 'discesa',
                  orario: '2026-11-27T09:30:00Z',
                  prenotazioni: ['1'],
                  passeggeriABordo: 3
                },
                {
                  tipo: 'discesa',
                  orario: '2026-11-27T10:00:00Z',
                  prenotazioni: ['2'],
                  passeggeriABordo: 0
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

let superati = 0;
let totale = 0;

function test(nome, fn) {
  totale++;

  try {
    fn();
    superati++;
    console.log('PASS:', nome);
  } catch (e) {
    console.error('FAIL:', nome);
    console.error(e);
    process.exitCode = 1;
  }
}

function negativo(nome, modifica, codice) {
  test(nome, () => {
    const s = scenario();
    const m = s.missioni[0];
    const g = m.gruppi[0];
    const f = g.itinerario.fermate;

    modifica(s, m, g, f);

    assert.throws(
      () => validaMissioniNcc(s),
      e => e.code === 'NCC_AUDIT_' + codice
    );
  });
}

test('Missione valida con otto passeggeri', () => {
  const r = validaMissioniNcc(scenario());

  assert.equal(r.valido, true);
  assert.equal(r.caricoRealeVerificato, true);
  assert.equal(r.fermateVerificate, 4);
  assert.equal(r.piccoMassimoVerificato, 8);
  assert.equal(r.prenotazioniVerificate, 2);
});

negativo(
  'Veicolo inesistente',
  s => { s.veicoli = []; },
  'VEICOLO_INESISTENTE'
);

negativo(
  'Veicolo occupato',
  s => { s.occupati.add('2026-11-27/10'); },
  'VEICOLO_OCCUPATO'
);

negativo(
  'Categoria veicolo incompatibile',
  s => { s.veicoli[0].tipo = 'bus'; },
  'CATEGORIA_VEICOLO_INCOMPATIBILE'
);

negativo(
  'Restrizioni gruppo eliminate',
  (s, m, g) => { g.tipiVeicoloAmmessi = null; },
  'RESTRIZIONI_GRUPPO_ALTERATE'
);

negativo(
  'Restrizioni missione eliminate',
  (s, m) => { m.tipiVeicoloAmmessi = null; },
  'RESTRIZIONI_MISSIONE_ALTERATE'
);

negativo(
  'Vincolo originale mancante',
  s => {
    delete s.prenotazioni[0].origineTipiVeicoloAmmessi;
  },
  'VINCOLO_ORIGINALE_INVALIDO'
);

negativo(
  'Prenotazione duplicata',
  (s, m, g) => { g.prenotazioni.push('1'); },
  'PRENOTAZIONE_DUPLICATA'
);

negativo(
  'Prenotazione sconosciuta',
  (s, m, g) => { g.prenotazioni.push('999'); },
  'PRENOTAZIONE_NON_AUTORIZZATA'
);

negativo(
  'Picco dichiarato inferiore al reale',
  (s, m, g) => { g.piccoPasseggeri = 5; },
  'PICCO_REALE_INCOERENTE'
);

negativo(
  'Sovraccarico reale nascosto',
  (s, m, g) => {
    s.prenotazioni[1].passeggeri = 4;
    g.passeggeri = 9;
    g.piccoPasseggeri = 5;
    m.passeggeri = 9;
    m.piccoPasseggeri = 5;
  },
  'CARICO_REALE_NON_AMMESSO'
);

negativo(
  'Carico fermata alterato',
  (s, m, g, f) => {
    f[1].passeggeriABordo = 5;
  },
  'CARICO_FERMATA_INCOERENTE'
);

negativo(
  'Salita duplicata',
  (s, m, g, f) => {
    f[1].prenotazioni = ['1'];
  },
  'SALITA_DUPLICATA'
);

negativo(
  'Discesa prima della salita',
  (s, m, g, f) => {
    f[0].tipo = 'discesa';
  },
  'DISCESA_INVALIDA'
);

negativo(
  'Discesa duplicata',
  (s, m, g, f) => {
    f[3].prenotazioni = ['1'];
  },
  'DISCESA_INVALIDA'
);

negativo(
  'Discesa mancante',
  (s, m, g, f) => { f.pop(); },
  'SERVIZIO_INCOMPLETO'
);

negativo(
  'Fermate mancanti',
  (s, m, g) => { g.itinerario.fermate = []; },
  'FERMATE_MANCANTI'
);

negativo(
  'Fermata senza prenotazioni',
  (s, m, g, f) => { f[0].prenotazioni = []; },
  'FERMATA_VUOTA'
);

negativo(
  'Prenotazione estranea alla fermata',
  (s, m, g, f) => { f[0].prenotazioni = ['999']; },
  'PRENOTAZIONE_FERMATA_ESTRANEA'
);

negativo(
  'Tipo fermata sconosciuto',
  (s, m, g, f) => { f[0].tipo = 'sosta'; },
  'TIPO_FERMATA_INVALIDO'
);

negativo(
  'Cronologia fermate invertita',
  (s, m, g, f) => {
    f[1].orario = '2026-11-27T07:59:00Z';
  },
  'CRONOLOGIA_FERMATE_INVALIDA'
);

negativo(
  'Fermata successiva alla fine del servizio',
  (s, m, g, f) => {
    f[3].orario = '2026-11-27T10:01:00Z';
  },
  'CRONOLOGIA_FERMATE_INVALIDA'
);

negativo(
  'Intervallo missione invalido',
  (s, m) => {
    m.logistica.arrivoBase = m.logistica.partenzaBase;
  },
  'INTERVALLO_MISSIONE_INVALIDO'
);

negativo(
  'Gruppo fuori intervallo missione',
  (s, m) => {
    m.logistica.arrivoBase = '2026-11-27T09:00:00Z';
  },
  'CRONOLOGIA_GRUPPI_INVALIDA'
);

negativo(
  'Giorno missione alterato',
  (s, m) => { m.giorno = '2026-11-28'; },
  'GIORNO_MISSIONE_INCOERENTE'
);

negativo(
  'Posti gruppo alterati',
  (s, m, g) => { g.posti = 20; },
  'POSTI_GRUPPO_INCOERENTI'
);

negativo(
  'Posti missione alterati',
  (s, m) => { m.posti = 20; },
  'POSTI_MISSIONE_INCOERENTI'
);

negativo(
  'Totale gruppo alterato',
  (s, m, g) => { g.passeggeri = 7; },
  'TOTALE_GRUPPO_INCOERENTE'
);

negativo(
  'Totale missione alterato',
  (s, m) => { m.passeggeri = 7; },
  'TOTALE_MISSIONE_INCOERENTE'
);

negativo(
  'Picco missione alterato',
  (s, m) => { m.piccoPasseggeri = 5; },
  'PICCO_MISSIONE_INCOERENTE'
);

negativo(
  'Missioni sovrapposte sullo stesso veicolo',
  (s, m) => {
    const seconda = structuredClone(m);

    seconda.gruppi[0].prenotazioni = ['3', '4'];

    for (const f of seconda.gruppi[0].itinerario.fermate) {
      f.prenotazioni = f.prenotazioni.map(
        id => String(Number(id) + 2)
      );
    }

    s.prenotazioni.push(
      ...s.prenotazioni.map(p => ({
        ...p,
        id: p.id + 2
      }))
    );

    s.missioni.push(seconda);
  },
  'MISSIONI_SOVRAPPOSTE'
);

test('Multisalita con ricambio passeggeri', () => {
  const s = scenario();
  const m = s.missioni[0];
  const g = m.gruppi[0];

  s.prenotazioni[1].passeggeri = 5;

  g.passeggeri = 10;
  m.passeggeri = 10;
  g.piccoPasseggeri = 5;
  m.piccoPasseggeri = 5;

  const f = g.itinerario.fermate;

  g.itinerario.fermate = [
    f[0],
    {
      ...f[2],
      orario: '2026-11-27T08:30:00Z',
      passeggeriABordo: 0
    },
    {
      ...f[1],
      orario: '2026-11-27T09:00:00Z',
      passeggeriABordo: 5
    },
    f[3]
  ];

  const r = validaMissioniNcc(s);

  assert.equal(r.valido, true);
  assert.equal(r.piccoMassimoVerificato, 5);
});

test('Interruzione validatore per perdita lease', () => {
  const s = scenario();

  let controlli = 0;

  s.verificaAttiva = () => {
    if (++controlli === 4) {
      throw new Error('LEASE_PERSO');
    }
  };

  assert.throws(
    () => validaMissioniNcc(s),
    /LEASE_PERSO/
  );
});

test('Piano vuoto valido', () => {
  const s = scenario();
  s.missioni = [];

  const r = validaMissioniNcc(s);

  assert.equal(r.valido, true);
  assert.equal(r.missioniVerificate, 0);
  assert.equal(r.prenotazioniVerificate, 0);
});

console.log('');
console.log(
  'TEST VALIDAZIONE MISSIONI SUPERATI:',
  superati, '/', totale
);

if (superati === totale) {
  console.log('V290.2E.2E.5C TEST COMPLETATI');
}
