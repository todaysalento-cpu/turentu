
import assert from 'node:assert/strict';

import {
  creaMatriceCpsatNcc
} from '../services/ncc-matrice-cpsat.service.js';

function scenario() {
  const richieste = [];
  const coordinate = new Map();

  const stato = {
    autorizzazioneRigorosa: true,
    geocodingAutonomoConsentito: false,
    interrotta: false,
    budgetEsaurito: false
  };

  const routing = {
    diagnostica: () => ({ ...stato }),

    async coordinate(nome) {
      return coordinate.get(nome) ?? null;
    },

    registraCoordinate(nome, punto) {
      coordinate.set(nome, punto);
    },

    async matrix(origine, destinazioni) {
      return destinazioni.map(destinazione => {
        richieste.push([origine, destinazione]);

        return {
          distanzaKm: 10,
          durataMs: 600000
        };
      });
    }
  };

  const veicoli = [
    {
      id: '10',
      tipo: 'minivan',
      posti: 8,
      lat: 40.35,
      lon: 18.17
    },
    {
      id: '20',
      tipo: 'minibus',
      posti: 19,
      lat: 40.63,
      lon: 17.94
    },
    {
      id: '30',
      tipo: 'bus',
      posti: 54,
      lat: 40.12,
      lon: 18.29
    }
  ];

  function servizio(id, ammessi, ora) {
    return {
      id,
      prenotazioni: [id],
      origine: 'Origine-' + id,
      destinazione: 'Destinazione-' + id,
      inizioMinimoMs: ora * 3600000,
      inizioMassimoMs: ora * 3600000,
      durataMs: 1800000,
      veicoliCompatibili: ammessi
    };
  }

  const catalogo = {
    versione: '2.9.0',
    veicoli,
    servizi: [
      servizio('A', ['10'], 8),
      servizio('B', ['20'], 10),
      servizio('C', ['10', '20', '30'], 12)
    ],
    vincoli: {
      attesaMassimaMs: 7200000,
      durataMassimaMissioneMs: 43200000
    }
  };

  return {
    catalogo,
    routing,
    richieste,
    coordinate,
    stato
  };
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

function base(v) {
  return '__BASE_NCC__' + v.lat + ',' + v.lon;
}

function contiene(richieste, a, b) {
  return richieste.some(
    t => t[0] === a && t[1] === b
  );
}

async function negativo(nome, modifica, errore) {
  await test(nome, async () => {
    const s = scenario();

    modifica(s);

    await assert.rejects(
      () => creaMatriceCpsatNcc(s),
      errore
    );
  });
}

await test('Matrice selettiva: 14 elementi su 24', async () => {
  const s = scenario();
  const r = await creaMatriceCpsatNcc(s);
  const d = r.diagnosticaMatrice;

  assert.equal(r.versione, '2.9.0');
  assert.equal(r.approvabile, false);

  assert.equal(d.elementiLogiciTeorici, 24);
  assert.equal(d.elementiLogici, 14);
  assert.equal(d.elementiLogiciRisparmiati, 10);
  assert.equal(d.percentualeRiduzione, 41.67);

  assert.equal(d.archiAmmessi, 4);
  assert.equal(d.archiIncompatibili, 2);
  assert.equal(d.combinazioniAmmesse, 5);
  assert.equal(d.combinazioniEscluse, 4);

  assert.equal(d.posizionamentiEsclusi, 4);
  assert.equal(d.rientriEsclusi, 4);

  assert.equal(r.matrice.trasferimenti.length, 4);
  assert.equal(r.matrice.posizionamenti.length, 5);
  assert.equal(r.matrice.rientri.length, 5);

  assert.equal(s.richieste.length, 14);
});

await test('Nessun routing tra servizi incompatibili', async () => {
  const s = scenario();

  await creaMatriceCpsatNcc(s);

  assert.equal(
    contiene(
      s.richieste,
      'Destinazione-A',
      'Origine-B'
    ),
    false
  );

  assert.equal(
    contiene(
      s.richieste,
      'Destinazione-B',
      'Origine-A'
    ),
    false
  );
});

await test('Nessun posizionamento incompatibile', async () => {
  const s = scenario();

  await creaMatriceCpsatNcc(s);

  const b = base(s.catalogo.veicoli[2]);

  assert.equal(
    contiene(s.richieste, b, 'Origine-A'),
    false
  );

  assert.equal(
    contiene(s.richieste, b, 'Origine-B'),
    false
  );

  assert.equal(
    contiene(s.richieste, b, 'Origine-C'),
    true
  );
});

await test('Nessun rientro incompatibile', async () => {
  const s = scenario();

  await creaMatriceCpsatNcc(s);

  const b = base(s.catalogo.veicoli[2]);

  assert.equal(
    contiene(s.richieste, 'Destinazione-A', b),
    false
  );

  assert.equal(
    contiene(s.richieste, 'Destinazione-B', b),
    false
  );

  assert.equal(
    contiene(s.richieste, 'Destinazione-C', b),
    true
  );
});

await test('Tutti gli archi necessari conservati', async () => {
  const s = scenario();
  const r = await creaMatriceCpsatNcc(s);

  const archi = r.matrice.trasferimenti
    .map(t => t.da + '/' + t.a)
    .sort();

  assert.deepEqual(
    archi,
    ['A/C', 'B/C', 'C/A', 'C/B']
  );
});

await test('Archi temporalmente impossibili conservati', async () => {
  const s = scenario();
  const r = await creaMatriceCpsatNcc(s);

  const arco = r.matrice.trasferimenti.find(
    t => t.da === 'C' && t.a === 'A'
  );

  assert.ok(arco);
  assert.equal(
    arco.direttoPotenzialmenteFattibile,
    false
  );
  assert.ok(arco.margineMs < 0);
});

await test('Prenotazioni condivise riconosciute', async () => {
  const s = scenario();

  s.catalogo.servizi[2].prenotazioni = ['A'];

  const r = await creaMatriceCpsatNcc(s);

  const arco = r.matrice.trasferimenti.find(
    t => t.da === 'A' && t.a === 'C'
  );

  assert.ok(arco);
  assert.equal(arco.condividonoPrenotazioni, true);
  assert.equal(
    arco.direttoPotenzialmenteFattibile,
    false
  );
});

await test('Compatibilita universale: matrice completa', async () => {
  const s = scenario();

  for (const servizio of s.catalogo.servizi) {
    servizio.veicoliCompatibili = ['10', '20', '30'];
  }

  const r = await creaMatriceCpsatNcc(s);

  assert.equal(r.diagnosticaMatrice.elementiLogici, 24);
  assert.equal(
    r.diagnosticaMatrice.elementiLogiciRisparmiati,
    0
  );

  assert.equal(r.matrice.trasferimenti.length, 6);
  assert.equal(r.matrice.posizionamenti.length, 9);
  assert.equal(r.matrice.rientri.length, 9);
});

await test('Servizi senza veicoli comuni', async () => {
  const s = scenario();

  s.catalogo.servizi[2].veicoliCompatibili = ['30'];

  const r = await creaMatriceCpsatNcc(s);

  assert.equal(r.matrice.trasferimenti.length, 0);
  assert.equal(r.matrice.posizionamenti.length, 3);
  assert.equal(r.matrice.rientri.length, 3);
  assert.equal(r.diagnosticaMatrice.elementiLogici, 6);
});

await test('Deduplicazione basi e tratte', async () => {
  const s = scenario();

  s.catalogo.veicoli[1].lat =
    s.catalogo.veicoli[0].lat;

  s.catalogo.veicoli[1].lon =
    s.catalogo.veicoli[0].lon;

  const r = await creaMatriceCpsatNcc(s);

  assert.equal(r.diagnosticaMatrice.basiRegistrate, 2);
  assert.equal(r.diagnosticaMatrice.elementiLogici, 14);
  assert.equal(r.diagnosticaMatrice.tratteUniche, 12);
  assert.equal(r.diagnosticaMatrice.tratteRiutilizzate, 2);
  assert.equal(s.richieste.length, 12);
});

await test('Riutilizzo basi gia registrate', async () => {
  const s = scenario();

  for (const v of s.catalogo.veicoli) {
    s.coordinate.set(base(v), {
      lat: v.lat,
      lon: v.lon
    });
  }

  const r = await creaMatriceCpsatNcc(s);

  assert.equal(r.diagnosticaMatrice.basiRegistrate, 0);
  assert.equal(r.diagnosticaMatrice.basiRiutilizzate, 3);
});

await test('Limite applicato alla matrice selettiva', async () => {
  const s = scenario();

  const r = await creaMatriceCpsatNcc({
    ...s,
    limiti: {
      maxElementiLogici: 14
    }
  });

  assert.equal(r.diagnosticaMatrice.elementiLogici, 14);
});

await negativo(
  'Limite elementi superato',
  s => {
    s.limiti = { maxElementiLogici: 13 };
  },
  /NCC_MATRICE_LIMITE_ELEMENTI/
);

await negativo(
  'Lista compatibilita mancante',
  s => {
    delete s.catalogo.servizi[0].veicoliCompatibili;
  },
  /NCC_MATRICE_COMPATIBILITA_INVALIDA/
);

await negativo(
  'Lista compatibilita vuota',
  s => {
    s.catalogo.servizi[0].veicoliCompatibili = [];
  },
  /NCC_MATRICE_COMPATIBILITA_INVALIDA/
);

await negativo(
  'Veicolo compatibile sconosciuto',
  s => {
    s.catalogo.servizi[0].veicoliCompatibili = ['999'];
  },
  /NCC_MATRICE_COMPATIBILITA_INVALIDA/
);

await negativo(
  'Veicolo compatibile duplicato',
  s => {
    s.catalogo.servizi[0].veicoliCompatibili = ['10', '10'];
  },
  /NCC_MATRICE_COMPATIBILITA_INVALIDA/
);

await negativo(
  'Servizio duplicato',
  s => {
    s.catalogo.servizi.push(s.catalogo.servizi[0]);
  },
  /NCC_MATRICE_SERVIZI_DUPLICATI/
);

await negativo(
  'Veicolo duplicato',
  s => {
    s.catalogo.veicoli.push(s.catalogo.veicoli[0]);
  },
  /NCC_MATRICE_VEICOLI_DUPLICATI/
);

await negativo(
  'Routing non rigoroso',
  s => {
    s.stato.autorizzazioneRigorosa = false;
  },
  /NCC_MATRICE_ROUTING_NON_RIGOROSO/
);

await negativo(
  'Geocoding autonomo non consentito',
  s => {
    s.stato.geocodingAutonomoConsentito = true;
  },
  /NCC_MATRICE_ROUTING_NON_RIGOROSO/
);

await negativo(
  'Budget esaurito prima del routing',
  s => {
    s.stato.budgetEsaurito = true;
  },
  /NCC_MATRICE_ROUTING_NON_DISPONIBILE/
);

await negativo(
  'Budget esaurito durante il routing',
  s => {
    const originale = s.routing.matrix;

    s.routing.matrix = async (...args) => {
      const r = await originale(...args);
      s.stato.budgetEsaurito = true;
      return r;
    };
  },
  /NCC_MATRICE_ROUTING_NON_COMPLETATO/
);

await negativo(
  'Risposta routing incompleta',
  s => {
    s.routing.matrix = async () => [];
  },
  /NCC_MATRICE_RISPOSTA_INCOMPLETA/
);

await negativo(
  'Tratta non disponibile',
  s => {
    s.routing.matrix = async (a, b) =>
      b.map(() => null);
  },
  /NCC_MATRICE_TRATTA_NON_DISPONIBILE/
);

await negativo(
  'Limite tratte uniche superato',
  s => {
    s.limiti = { maxTratteUniche: 13 };
  },
  /NCC_MATRICE_LIMITE_TRATTE_UNICHE/
);

await negativo(
  'Perdita lease durante routing',
  s => {
    let attiva = true;
    const originale = s.routing.matrix;

    s.verificaAttiva = () => {
      if (!attiva) throw new Error('LEASE_PERSO');
    };

    s.routing.matrix = async (...args) => {
      const r = await originale(...args);
      attiva = false;
      return r;
    };
  },
  /LEASE_PERSO/
);

await test('Catalogo originale non modificato', async () => {
  const s = scenario();
  const prima = structuredClone(s.catalogo);

  await creaMatriceCpsatNcc(s);

  assert.deepEqual(s.catalogo, prima);
});

await test('Catalogo senza servizi', async () => {
  const s = scenario();

  s.catalogo.servizi = [];

  const r = await creaMatriceCpsatNcc(s);

  assert.equal(r.diagnosticaMatrice.elementiLogici, 0);
  assert.equal(r.diagnosticaMatrice.percentualeRiduzione, 0);
  assert.equal(r.matrice.trasferimenti.length, 0);
  assert.equal(r.matrice.posizionamenti.length, 0);
  assert.equal(r.matrice.rientri.length, 0);
  assert.equal(s.richieste.length, 0);
});

console.log('');
console.log(
  'TEST MATRICE CP-SAT SUPERATI:',
  superati, '/', totale
);

if (superati === totale) {
  console.log('V290.2E.2F.1C.1 TEST COMPLETATI');
}
