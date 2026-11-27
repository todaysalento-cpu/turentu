import assert from 'node:assert/strict';

import {
  validaSoluzioneCpsatNcc
} from '../services/ncc-validatore-cpsat.service.js';

import {
  validaPrenotazioniCpsatNcc
} from '../services/ncc-validazione-prenotazioni.service.js';

import {
  verificaItinerarioNcc
} from '../services/ncc-aggregazione.service.js';

export async function testValidazioneNcc({
  catalogo,
  risultato,
  prenotazioniOriginali,
  veicoliOriginali,
  routing,
  verificaAttiva
}) {

  const prima = JSON.stringify({
    catalogo,
    risultato
  });

  const logistica = validaSoluzioneCpsatNcc({
    catalogo,
    risultato,
    prenotazioniOriginali,
    veicoliOriginali,
    verificaAttiva
  });

  const valida = (
    c = catalogo,
    v = logistica
  ) => validaPrenotazioniCpsatNcc({
    catalogo: c,
validazione: v,
prenotazioniOriginali,
veicoliOriginali,
routing,
verificaAttiva
  });

  const routingPrimaPositivo =
    structuredClone(routing.diagnostica());

  const validazione = await valida();

  const routingDopoPositivo =
    structuredClone(routing.diagnostica());

  console.log(
    'ROUTING VALIDAZIONE POSITIVA:',
    JSON.stringify({
      prima: routingPrimaPositivo,
      dopo: routingDopoPositivo
    }, null, 2)
  );

  assert.equal(validazione.valida, true);

  assert.equal(
    validazione.prenotazioniAssegnate.length,
    20
  );

  assert.equal(validazione.escluse.length, 0);
  assert.equal(validazione.ricavi, 1791.18);

  assert.equal(
    validazione.diagnosticaPrenotazioni
      .prenotazioniVerificate,
    20
  );

  console.log('VALIDAZIONE PRENOTAZIONI: OK');

  let positivi = 1;
  let negativi = 0;

  async function rifiuta(nome, modifica, errore) {

    const c = structuredClone(catalogo);
    const v = structuredClone(logistica);

    modifica(c, v);

    const primaNegativo =
      structuredClone(routing.diagnostica());

    await assert.rejects(
      valida(c, v),
      errore
    );

    const dopoNegativo =
      structuredClone(routing.diagnostica());

    const variazioni = {};

    for (const [k, valore] of
      Object.entries(dopoNegativo)) {

      if (
        typeof valore === 'number' &&
        typeof primaNegativo[k] === 'number' &&
        valore !== primaNegativo[k]
      ) {
        variazioni[k] =
          valore - primaNegativo[k];
      }
    }

    console.log(
      'ROUTING TEST ' + nome + ':',
      JSON.stringify(variazioni)
    );

    negativi++;

    console.log('RIFIUTO ' + nome + ': OK');
  }

  function primaSalita(v) {
    return v.serviziTraslati[0]
      .proposta.itinerario.fermate
      .find(f => f.tipo === 'salita');
  }

  function ultimaDiscesa(v) {
    return v.serviziTraslati[0]
      .proposta.itinerario.fermate
      .at(-1);
  }

  function prenotazione(c, v) {

    const id =
      primaSalita(v).prenotazioni[0];

    return c.prenotazioni.find(
      p => String(p.id) === String(id)
    );
  }

  await rifiuta(
    'SERVIZIO DUPLICATO',
    (c, v) => {
      v.serviziTraslati.push(
        structuredClone(v.serviziTraslati[0])
      );
      v.audit.serviziCompatibilitaVerificata++;
    },
    /SERVIZIO_DUPLICATO/
  );

  await rifiuta(
    'PRENOTAZIONE DUPLICATA',
    (c, v) => {
      const f = primaSalita(v);
      f.prenotazioni.push(f.prenotazioni[0]);
    },
    /PRENOTAZIONI_FERMATA/
  );

  await rifiuta(
    'PRELIEVO FUORI TOLLERANZA',
    (c, v) => {
      const r = prenotazione(c, v);

      r.prelievo_il = new Date(
        Date.parse(primaSalita(v).orario) +
        3600000
      ).toISOString();
    },
    /PRELIEVO_FUORI_FINESTRA/
  );

  await rifiuta(
    'CARICO ALTERATO',
    (c, v) => {
      primaSalita(v).passeggeriABordo++;
    },
    /CARICO_DICHIARATO_INCOERENTE/
  );

  await rifiuta(
    'PASSEGGERI ALTERATI',
    (c, v) => {
      prenotazione(c, v).passeggeri = 100;
    },
    /NCC_AUDIT_CPSAT_PASSEGGERI_ALTERATI/
  );

  {
    const r = structuredClone(risultato);
    const candidato = r.soluzione.servizi.map(s => ({
      assegnazione: s,
      servizio: catalogo.servizi.find(c => c.id === s.servizio)
    })).find(x => x.servizio && catalogo.veicoli.some(v => v.posti < x.servizio.piccoPasseggeri));
    assert.ok(candidato, 'SCENARIO CAPIENZA NON DISPONIBILE');
    const incompatibile = catalogo.veicoli.find(v => v.posti < candidato.servizio.piccoPasseggeri);
    candidato.assegnazione.veicolo = incompatibile.id;
    assert.throws(() => validaSoluzioneCpsatNcc({
      catalogo,
      risultato: r,
      prenotazioniOriginali,
      veicoliOriginali,
      verificaAttiva
    }), /NCC_AUDIT_CPSAT_VEICOLO_NON_COMPATIBILE/);
    negativi++;
    console.log('RIFIUTO CAPIENZA SUPERATA: OK');
  }

  await rifiuta(
    'ULTERIORE ALTERAZIONE PASSEGGERI',
    (c, v) => {
      prenotazione(c, v).passeggeri = 101;
    },
    /NCC_AUDIT_CPSAT_PASSEGGERI_ALTERATI/
  );

  await rifiuta(
    'ORIGINE ALTERATA',
    (c, v) => {
      const r = prenotazione(c, v);

      r.origine =
        r.origine === 'Lecce'
          ? 'Maglie'
          : 'Lecce';
    },
    /ORIGINE_ERRATA/
  );

  await rifiuta(
    'DESTINAZIONE ALTERATA',
    (c, v) => {
      const r = prenotazione(c, v);

      r.destinazione =
        r.destinazione === 'Lecce'
          ? 'Maglie'
          : 'Lecce';
    },
    /DESTINAZIONE_ERRATA/
  );

  await rifiuta(
    'KM PROGRESSIVI ALTERATI',
    (c, v) => {
      ultimaDiscesa(v).kmProgressivi += 10;
    },
    /KM_PROGRESSIVI_INCOERENTI/
  );

  await rifiuta(
    'RICAVI ALTERATI',
    (c, v) => {
      prenotazione(c, v).prezzo_centesimi++;
    },
    /RICAVI_INCOERENTI/
  );

  await rifiuta(
    'PRENOTAZIONE ESTRANEA',
    (c, v) => {
      primaSalita(v).prenotazioni.push(
        'INESISTENTE'
      );
    },
    /PRENOTAZIONE_ESTRANEA/
  );

  await rifiuta(
    'DISCESA MANCANTE',
    (c, v) => {
      const f = ultimaDiscesa(v);
      f.prenotazioni = [];
    },
    /PRENOTAZIONI_FERMATA/
  );

  await rifiuta(
    'VOLO NON VALIDO',
    (c, v) => {
      const r = prenotazione(c, v);

      r.volo_direzione = 'partenza';
      r.volo_programmato_il = 'INVALIDO';
    },
    /VOLO_PARTENZA_INVALIDO/
  );

  await rifiuta(
    'PRELIEVO PRIMA DEL VOLO',
    (c, v) => {
      const r = prenotazione(c, v);

      r.prelievo_il = primaSalita(v).orario;

      r.volo_direzione = 'arrivo';

      r.volo_programmato_il = new Date(
        Date.parse(primaSalita(v).orario) +
        600000
      ).toISOString();
    },
    /PRELIEVO_FUORI_FINESTRA/
  );

  await rifiuta(
    'ARRIVO TARDIVO AEROPORTO',
    (c, v) => {
      const r = prenotazione(c, v);

      r.volo_direzione = 'partenza';

      r.volo_programmato_il = new Date(
        Date.parse(ultimaDiscesa(v).orario) +
        1800000
      ).toISOString();
    },
    /DEADLINE_VOLO/
  );

  for (const direzione of [
    'arrivo',
    'partenza'
  ]) {

    const c = structuredClone(catalogo);
    const v = structuredClone(logistica);

    const r = prenotazione(c, v);

    r.volo_direzione = direzione;
    r.volo_numero = 'TEST123';

    r.volo_programmato_il =
      new Date(
        direzione === 'arrivo'
          ? Date.parse(primaSalita(v).orario) -
              1800000
          : Date.parse(ultimaDiscesa(v).orario) +
              7200000
      ).toISOString();

    const esito = await valida(c, v);

    assert.equal(esito.valida, true);

    positivi++;

    console.log(
      'VOLO COMPATIBILE ' +
      direzione.toUpperCase() +
      ': OK'
    );
  }

  await assert.rejects(
    validaPrenotazioniCpsatNcc({
      catalogo,
      validazione: logistica,
      routing,

      verificaAttiva: () => {
        throw new Error(
          'TEST_CANCELLAZIONE_VALIDATORE'
        );
      }
    }),
    /TEST_CANCELLAZIONE_VALIDATORE/
  );

  negativi++;

  assert.equal(
    JSON.stringify({ catalogo, risultato }),
    prima
  );

  console.log('CANCELLAZIONE VALIDATORE: OK');
  console.log('INPUT ORIGINALI INALTERATI: OK');

  return {
    validazione,
    positivi,
    negativi
  };
}

export async function testDomiciliNcc({
  routing,
  riferimento,
  verificaAttiva
}) {

  const MIN = 60000;

  const aeroporto =
    'Aeroporto di Brindisi (BDS)';

  const domicili = {
    A: 'TEST DOMICILIO A - Tricase',
    B: 'TEST DOMICILIO B - Tricase',
    C: 'TEST DOMICILIO C - Tricase',

    D: 'TEST DOMICILIO D - Tiggiano',
    E: 'TEST DOMICILIO E - Alessano',

    F: 'TEST DOMICILIO F - Lecce',
    G: 'TEST DOMICILIO G - Lecce',
    H: 'TEST DOMICILIO H - Lecce'
  };

  const coordinate = {
    A: [39.9302, 18.3584],
    B: [39.9310, 18.3590],
    C: [39.9320, 18.3600],

    D: [39.9035, 18.3630],
    E: [39.8910, 18.3310],

    F: [40.3522, 18.1755],
    G: [40.3530, 18.1760],
    H: [40.3540, 18.1770]
  };

  for (const [id, nome] of Object.entries(domicili)) {

    const [lat, lon] = coordinate[id];

    routing.registraCoordinate(
      nome,
      { lat, lon }
    );
  }

  const pickup =
    riferimento + 6 * 60 * MIN;

  const iso = ms =>
    new Date(ms).toISOString();

  function creaRows(origini, destinazioni, extra = {}) {

    return origini.map((origine, i) => ({
      id: 'DOM-' + (i + 1),
      origine,
      destinazione: destinazioni[i],
      prelievo_il: iso(pickup),
      passeggeri: 2,
      prezzo_centesimi: 6000,
      bagagli: 0,
      ...extra
    }));
  }

  const scenari = [
    {
      nome: 'B - MULTISALITA STESSO COMUNE',

      rows: creaRows(
        [domicili.A, domicili.B, domicili.C],
        [aeroporto, aeroporto, aeroporto]
      ),

      salite: 3,
      discese: 1
    },

    {
      nome: 'C - MULTISALITA COMUNI DIFFERENTI',

      rows: creaRows(
        [domicili.A, domicili.D, domicili.E],
        [aeroporto, aeroporto, aeroporto]
      ),

      salite: 3,
      discese: 1
    },

    {
      nome: 'D - AEROPORTO MULTIDISCESA',

      rows: creaRows(
        [aeroporto, aeroporto, aeroporto],
        [domicili.F, domicili.G, domicili.H]
      ),

      salite: 1,
      discese: 3
    },

    {
      nome: 'E - DOMICILIO DOMICILIO',

      rows: creaRows(
        [domicili.A, domicili.B, domicili.C],
        [domicili.F, domicili.G, domicili.H]
      ),

      salite: 3,
      discese: 3
    },

    {
      nome: 'F1 - DOMICILI VOLO PARTENZA',

      rows: creaRows(
        [domicili.A, domicili.B, domicili.C],
        [aeroporto, aeroporto, aeroporto],

        {
          volo_numero: 'TEST456',
          volo_aeroporto: 'BDS',
          volo_direzione: 'partenza',

          volo_programmato_il: iso(
            pickup + 5 * 60 * MIN
          )
        }
      ),

      salite: 3,
      discese: 1
    },

    {
      nome: 'F2 - VOLO ARRIVO DOMICILI',

      rows: creaRows(
        [aeroporto, aeroporto, aeroporto],
        [domicili.F, domicili.G, domicili.H],

        {
          volo_numero: 'TEST789',
          volo_aeroporto: 'BDS',
          volo_direzione: 'arrivo',

          volo_programmato_il: iso(
            pickup - 30 * MIN
          )
        }
      ),

      salite: 1,
      discese: 3
    }
  ];

  const risultati = [];

  for (const scenario of scenari) {

    verificaAttiva();

    const itinerario = await verificaItinerarioNcc(
      scenario.rows,
      routing,
      7,

      {
        tolleranzaMinuti: 30,
        deviazioneMassima: 0.25,
        tempoAggiuntivoMinuti: 25,
        maxFermate: 6
      },

      riferimento,

      {
        finestreTemporali: true,
        verificaAttiva
      }
    );

    assert.ok(
      itinerario,
      'ITINERARIO NON GENERATO: ' +
        scenario.nome
    );

    const salite = itinerario.fermate.filter(
      f => f.tipo === 'salita'
    );

    const discese = itinerario.fermate.filter(
      f => f.tipo === 'discesa'
    );

    assert.equal(
      salite.length,
      scenario.salite
    );

    assert.equal(
      discese.length,
      scenario.discese
    );

    for (const row of scenario.rows) {

      const salita = salite.find(
        f => f.prenotazioni.includes(
          String(row.id)
        )
      );

      const discesa = discese.find(
        f => f.prenotazioni.includes(
          String(row.id)
        )
      );

      assert.ok(salita);
      assert.ok(discesa);

      assert.equal(
        salita.localita,
        row.origine
      );

      assert.equal(
        discesa.localita,
        row.destinazione
      );

      assert.ok(
        Date.parse(discesa.orario) >=
        Date.parse(salita.orario)
      );
    }

    assert.ok(
      itinerario.piccoPasseggeri <= 7
    );

    assert.equal(
      itinerario.fermate.at(-1)
        .passeggeriABordo,
      0
    );

    risultati.push({
      scenario: scenario.nome,
      prenotazioni: scenario.rows.length,
      salite: salite.length,
      discese: discese.length,
      picco: itinerario.piccoPasseggeri,
      km: itinerario.km,
      esito: 'OK'
    });

    console.log(scenario.nome + ': OK');
  }

  console.table(risultati);

  return risultati;
}