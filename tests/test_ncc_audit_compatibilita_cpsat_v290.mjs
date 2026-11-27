
import assert from 'node:assert/strict';

import {
  creaAuditCompatibilitaCpsatNcc
} from '../services/ncc-audit-compatibilita-cpsat.service.js';

import {
  validaSoluzioneCpsatNcc
} from '../services/ncc-validatore-cpsat.service.js';

import {
  validaPrenotazioniCpsatNcc
} from '../services/ncc-validazione-prenotazioni.service.js';

function scenario() {
  const prenotazioniOriginali = [
    {
      id: '1',
      passeggeri: 5,
      origineTipiVeicoloAmmessi: ['minivan', 'van'],
      destinazioneTipiVeicoloAmmessi: ['minivan']
    },
    {
      id: '2',
      passeggeri: 6,
      origineTipiVeicoloAmmessi: null,
      destinazioneTipiVeicoloAmmessi: ['minivan']
    }
  ];

  const veicoliOriginali = [
    {
      id: '10',
      tipo: 'minivan',
      posti_totali: 8
    },
    {
      id: '20',
      tipo: 'minibus',
      posti_totali: 19
    },
    {
      id: '30',
      tipo: 'minivan',
      posti_totali: 4
    },
    {
      id: '40',
      tipo: 'minivan',
      posti_totali: 8
    }
  ];

  const servizio = {
    id: 'S1',
    prenotazioni: ['1', '2'],
    passeggeri: 11,
    piccoPasseggeri: 6,
    tipiVeicoloAmmessi: ['minivan'],
    veicoliCompatibili: ['10', '40'],

    proposta: {
      prenotazioni: ['1', '2'],
      passeggeri: 11,
      piccoPasseggeri: 6,
      tipiVeicoloAmmessi: ['minivan']
    }
  };

  const catalogo = {
    versione: '2.9.0',

    prenotazioni:
      structuredClone(prenotazioniOriginali),

    veicoli: veicoliOriginali.map(v => ({
      id: v.id,
      tipo: v.tipo,
      posti: v.posti_totali,
      veicolo: structuredClone(v)
    })),

    servizi: [servizio]
  };

  return {
    catalogo,
    prenotazioniOriginali,
    veicoliOriginali
  };
}

function esegui(s, veicoloId = '10', proposta) {
  const audit =
    creaAuditCompatibilitaCpsatNcc(s);

  return audit.verificaServizio({
    servizio: s.catalogo.servizi[0],
    veicoloId,
    proposta
  });
}

let totale = 0;
let superati = 0;

async function test(nome, fn) {
  totale++;

  try {
    await fn();
    superati++;
    console.log('PASS:', nome);
  } catch (e) {
    console.error('FAIL:', nome);
    console.error(e);
    process.exitCode = 1;
  }
}

async function negativo(
  nome,
  modifica,
  errore,
  veicoloId = '10'
) {
  await test(nome, () => {
    const s = scenario();

    modifica(s);

    assert.throws(
      () => esegui(s, veicoloId),
      errore
    );
  });
}

await test('Compatibilita corretta', () => {
  const r = esegui(scenario());

  assert.equal(r.valido, true);

  assert.deepEqual(
    r.tipiVeicoloAmmessi,
    ['minivan']
  );

  assert.deepEqual(
    r.veicoliCompatibili,
    ['10', '40']
  );
});

await test('Secondo veicolo compatibile', () => {
  const r = esegui(scenario(), '40');

  assert.equal(r.valido, true);
});

await test('Carico sequenziale superiore ai posti totali', () => {
  const s = scenario();
  const r = esegui(s);

  assert.equal(r.piccoPasseggeri, 6);
  assert.equal(s.catalogo.servizi[0].passeggeri, 11);
});

await test('Ordine lista compatibili irrilevante', () => {
  const s = scenario();

  s.catalogo.servizi[0].veicoliCompatibili.reverse();

  assert.equal(esegui(s).valido, true);
});

await test('Normalizzazione categorie equivalenti', () => {
  const s = scenario();

  s.catalogo.prenotazioni[0]
    .origineTipiVeicoloAmmessi = [
      ' VAN ',
      'MINIVAN'
    ];

  assert.equal(esegui(s).valido, true);
});

await negativo(
  'Prenotazioni originali mancanti',
  s => {
    delete s.prenotazioniOriginali;
  },
  /NCC_AUDIT_CPSAT_PRENOTAZIONI_ORIGINALI/
);

await negativo(
  'Flotta originale mancante',
  s => {
    delete s.veicoliOriginali;
  },
  /NCC_AUDIT_CPSAT_FLOTTA_ORIGINALE/
);

await negativo(
  'Restrizione originale mancante',
  s => {
    delete s.prenotazioniOriginali[0]
      .origineTipiVeicoloAmmessi;
  },
  /RESTRIZIONE_MANCANTE/
);

await negativo(
  'Restrizione catalogo mancante',
  s => {
    delete s.catalogo.prenotazioni[0]
      .destinazioneTipiVeicoloAmmessi;
  },
  /RESTRIZIONE_MANCANTE/
);

await negativo(
  'Restrizione sostituita con null',
  s => {
    s.catalogo.prenotazioni[0]
      .destinazioneTipiVeicoloAmmessi = null;
  },
  /RESTRIZIONI_ALTERATE/
);

await negativo(
  'Restrizione malformata',
  s => {
    s.prenotazioniOriginali[0]
      .origineTipiVeicoloAmmessi = 'minivan';
  },
  /RESTRIZIONE_INVALIDA/
);

await negativo(
  'Categoria geografica sconosciuta',
  s => {
    s.prenotazioniOriginali[0]
      .origineTipiVeicoloAmmessi = ['elicottero'];
  },
  /RESTRIZIONE_INVALIDA/
);

await negativo(
  'Passeggeri originali alterati nel catalogo',
  s => {
    s.catalogo.prenotazioni[0].passeggeri = 1;
  },
  /PASSEGGERI_ALTERATI/
);

await negativo(
  'Prenotazione rimossa dal catalogo',
  s => {
    s.catalogo.prenotazioni.pop();
  },
  /PRENOTAZIONI_ALTERATE/
);

await negativo(
  'Prenotazione originale duplicata',
  s => {
    s.prenotazioniOriginali.push(
      s.prenotazioniOriginali[0]
    );
  },
  /PRENOTAZIONI_ORIGINALI/
);

await negativo(
  'Veicolo rimosso dal catalogo',
  s => {
    s.catalogo.veicoli.pop();
  },
  /FLOTTA_ALTERATA/
);

await negativo(
  'Veicolo originale duplicato',
  s => {
    s.veicoliOriginali.push(
      s.veicoliOriginali[0]
    );
  },
  /FLOTTA_ORIGINALE/
);

await negativo(
  'Capienza veicolo aumentata artificialmente',
  s => {
    s.catalogo.veicoli[2].posti = 8;
  },
  /CAPIENZA_VEICOLO_ALTERATA/
);

await negativo(
  'Categoria veicolo alterata',
  s => {
    s.catalogo.veicoli[1].tipo = 'minivan';
  },
  /TIPO_VEICOLO_ALTERATO/
);

await negativo(
  'Categoria veicolo mancante',
  s => {
    delete s.catalogo.veicoli[0].tipo;
  },
  /TIPO_VEICOLO_MANCANTE/
);

await negativo(
  'Restrizioni servizio alterate',
  s => {
    s.catalogo.servizi[0].tipiVeicoloAmmessi = null;
  },
  /RESTRIZIONI_ALTERATE/
);

await negativo(
  'Restrizioni proposta alterate',
  s => {
    s.catalogo.servizi[0]
      .proposta.tipiVeicoloAmmessi = null;
  },
  /RESTRIZIONI_ALTERATE/
);

await negativo(
  'Restrizioni proposta mancanti',
  s => {
    delete s.catalogo.servizi[0]
      .proposta.tipiVeicoloAmmessi;
  },
  /RESTRIZIONE_INVALIDA/
);

await negativo(
  'Veicolo incompatibile aggiunto alla lista',
  s => {
    s.catalogo.servizi[0]
      .veicoliCompatibili.push('20');
  },
  /LISTA_COMPATIBILITA_ALTERATA/
);

await negativo(
  'Veicolo compatibile rimosso dalla lista',
  s => {
    s.catalogo.servizi[0]
      .veicoliCompatibili.pop();
  },
  /LISTA_COMPATIBILITA_ALTERATA/
);

await negativo(
  'Veicolo duplicato nella lista',
  s => {
    s.catalogo.servizi[0]
      .veicoliCompatibili.push('10');
  },
  /LISTA_COMPATIBILITA_ALTERATA/
);

await negativo(
  'Lista compatibilita mancante',
  s => {
    delete s.catalogo.servizi[0]
      .veicoliCompatibili;
  },
  /LISTA_COMPATIBILITA_MANCANTE/
);

await negativo(
  'Assegnazione a categoria incompatibile',
  () => {},
  /VEICOLO_NON_COMPATIBILE/,
  '20'
);

await negativo(
  'Assegnazione a veicolo troppo piccolo',
  () => {},
  /VEICOLO_NON_COMPATIBILE/,
  '30'
);

await negativo(
  'Assegnazione a veicolo sconosciuto',
  () => {},
  /VEICOLO_NON_COMPATIBILE/,
  '999'
);

await negativo(
  'Picco inferiore alla singola prenotazione',
  s => {
    s.catalogo.servizi[0].piccoPasseggeri = 5;
    s.catalogo.servizi[0].proposta.piccoPasseggeri = 5;
  },
  /PICCO_PASSEGGERI_INVALIDO/
);

await negativo(
  'Picco proposta incoerente',
  s => {
    s.catalogo.servizi[0].proposta.piccoPasseggeri = 7;
  },
  /PICCO_PASSEGGERI_INVALIDO/
);

await negativo(
  'Totale passeggeri alterato',
  s => {
    s.catalogo.servizi[0].passeggeri = 6;
  },
  /TOTALE_PASSEGGERI_ALTERATO/
);

await negativo(
  'Prenotazione duplicata nel servizio',
  s => {
    s.catalogo.servizi[0].prenotazioni.push('1');
  },
  /PRENOTAZIONI_DUPLICATE/
);

await negativo(
  'Identita proposta alterata',
  s => {
    s.catalogo.servizi[0].proposta.prenotazioni = ['1'];
  },
  /IDENTITA_SERVIZIO_ALTERATA/
);

await negativo(
  'Prenotazione inesistente nel servizio',
  s => {
    s.catalogo.servizi[0].prenotazioni = ['1', '999'];

    s.catalogo.servizi[0]
      .proposta.prenotazioni = ['1', '999'];
  },
  /PRENOTAZIONE_ORIGINALE_MANCANTE/
);

await negativo(
  'Punto operativo senza veicoli ammessi',
  s => {
    s.prenotazioniOriginali[0]
      .origineTipiVeicoloAmmessi = [];

    s.catalogo.prenotazioni[0]
      .origineTipiVeicoloAmmessi = [];

    s.catalogo.servizi[0]
      .tipiVeicoloAmmessi = [];

    s.catalogo.servizi[0]
      .proposta.tipiVeicoloAmmessi = [];
  },
  /NESSUN_VEICOLO_COMPATIBILE/
);

await test('Proposta traslata compatibile', () => {
  const s = scenario();

  const proposta = {
    ...structuredClone(
      s.catalogo.servizi[0].proposta
    ),
    inizio: '2026-11-27T10:00:00+01:00',
    fine: '2026-11-27T11:00:00+01:00'
  };

  assert.equal(
    esegui(s, '10', proposta).valido,
    true
  );
});

await test('Restrizione persa nella proposta traslata', () => {
  const s = scenario();

  const proposta = structuredClone(
    s.catalogo.servizi[0].proposta
  );

  delete proposta.tipiVeicoloAmmessi;

  assert.throws(
    () => esegui(s, '10', proposta),
    /RESTRIZIONE_INVALIDA/
  );
});

await test('Perdita lease', () => {
  const s = scenario();

  s.verificaAttiva = () => {
    throw new Error('LEASE_PERSO');
  };

  assert.throws(
    () => esegui(s),
    /LEASE_PERSO/
  );
});

await test('Dati originali non modificati', () => {
  const s = scenario();
  const prima = structuredClone(s);

  esegui(s);

  assert.deepEqual(s, prima);
});

await test('Validatore logistico senza snapshot', () => {
  const s = scenario();

  assert.throws(
    () => validaSoluzioneCpsatNcc({
      catalogo: s.catalogo,
      risultato: {}
    }),
    /NCC_AUDIT_CPSAT_PRENOTAZIONI_ORIGINALI/
  );
});

await test('Validatore logistico blocca flotta alterata', () => {
  const s = scenario();

  s.catalogo.veicoli[1].tipo = 'minivan';

  assert.throws(
    () => validaSoluzioneCpsatNcc({
      ...s,
      risultato: {}
    }),
    /TIPO_VEICOLO_ALTERATO/
  );
});

await test('Validatore prenotazioni senza snapshot', async () => {
  const s = scenario();

  await assert.rejects(
    () => validaPrenotazioniCpsatNcc({
      catalogo: s.catalogo,
      validazione: { valida: true }
    }),
    /NCC_AUDIT_CPSAT_PRENOTAZIONI_ORIGINALI/
  );
});

await test('Validatore prenotazioni senza audit logistico', async () => {
  const s = scenario();

  await assert.rejects(
    () => validaPrenotazioniCpsatNcc({
      ...s,
      validazione: { valida: true }
    }),
    /AUDIT_LOGISTICO_MANCANTE/
  );
});

await test('Audit logistico incompleto', async () => {
  const s = scenario();

  await assert.rejects(
    () => validaPrenotazioniCpsatNcc({
      ...s,

      validazione: {
        valida: true,

        serviziTraslati: [
          { servizio: 'S1', veicolo: '10' }
        ],

        audit: {
          compatibilitaIndipendenteVerificata: true,
          datiOriginaliVerificati: true,
          serviziCompatibilitaVerificata: 0
        }
      }
    }),
    /AUDIT_LOGISTICO_INCOMPLETO/
  );
});

console.log('');

console.log(
  'TEST AUDIT COMPATIBILITA CP-SAT SUPERATI:',
  superati, '/', totale
);

if (superati === totale) {
  console.log(
    'V290.2E.2F.1D.3 TEST COMPLETATI'
  );
}
