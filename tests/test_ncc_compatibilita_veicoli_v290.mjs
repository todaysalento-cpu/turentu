
import assert from 'node:assert/strict';

import {
  normalizzaTipoVeicoloNcc,
  normalizzaRestrizioniNcc,
  intersecaRestrizioniNcc,
  veicoloCompatibileNcc,
  restrizioniPrenotazioneNcc,
  restrizioniGruppoNcc,
  veicoliCompatibiliNcc
} from '../services/ncc-compatibilita-veicoli.service.js';

let superati = 0;

function test(nome, fn) {
  fn();
  superati++;
  console.log('PASS:', nome);
}

const flotta = [
  { id: 1, tipo: 'auto', posti_totali: 4 },
  { id: 2, tipo: 'berlina', posti_totali: 4 },
  { id: 3, tipo: 'suv', posti_totali: 4 },
  { id: 4, tipo: 'van', posti_totali: 8 },
  { id: 5, tipo: 'minivan', posti_totali: 8 },
  { id: 6, tipo: 'minibus', posti_totali: 20 },
  { id: 7, tipo: 'bus', posti_totali: 54 },
  { id: 8, tipo: null, posti_totali: 50 }
];

test('Normalizzazione categoria', () => {
  assert.equal(
    normalizzaTipoVeicoloNcc(' MINIBUS '),
    'minibus'
  );
});

test('Categoria sconosciuta', () => {
  assert.equal(
    normalizzaTipoVeicoloNcc('elicottero'),
    null
  );
});

test('Categoria assente', () => {
  assert.equal(
    normalizzaTipoVeicoloNcc(null),
    null
  );
});

test('Restrizione NULL libera', () => {
  assert.equal(
    normalizzaRestrizioniNcc(null),
    null
  );
});

test('Array vuoto blocca tutti', () => {
  assert.deepEqual(
    normalizzaRestrizioniNcc([]),
    []
  );
});

test('Restrizione malformata bloccata', () => {
  assert.deepEqual(
    normalizzaRestrizioniNcc('bus'),
    []
  );
});

test('Deduplicazione categorie', () => {
  assert.deepEqual(
    normalizzaRestrizioniNcc([
      'BUS', 'bus', 'van', 'sconosciuto'
    ]),
    ['bus', 'van']
  );
});

test('Intersezione con NULL', () => {
  assert.deepEqual(
    intersecaRestrizioniNcc(null, ['van']),
    ['van']
  );
});

test('Intersezione compatibile', () => {
  assert.deepEqual(
    intersecaRestrizioniNcc(
      ['van', 'minibus'],
      ['minibus', 'bus']
    ),
    ['minibus']
  );
});

test('Intersezione incompatibile', () => {
  assert.deepEqual(
    intersecaRestrizioniNcc(
      ['van'],
      ['bus']
    ),
    []
  );
});

test('Intersezione senza restrizioni', () => {
  assert.equal(
    intersecaRestrizioniNcc(null, null),
    null
  );
});

test('Veicolo esplicitamente ammesso', () => {
  assert.equal(
    veicoloCompatibileNcc(flotta[3], ['van']),
    true
  );
});

test('Bus escluso da punto limitato', () => {
  assert.equal(
    veicoloCompatibileNcc(
      flotta[6],
      ['auto', 'van']
    ),
    false
  );
});

test('Non classificato senza restrizioni', () => {
  assert.equal(
    veicoloCompatibileNcc(flotta[7], null),
    true
  );
});

test('Non classificato con restrizioni', () => {
  assert.equal(
    veicoloCompatibileNcc(flotta[7], ['bus']),
    false
  );
});

test('Prenotazione domiciliare libera', () => {
  assert.equal(
    restrizioniPrenotazioneNcc({}),
    null
  );
});

test('Vincoli origine e destinazione', () => {
  assert.deepEqual(
    restrizioniPrenotazioneNcc({
      origineTipiVeicoloAmmessi: [
        'van', 'minibus'
      ],
      destinazioneTipiVeicoloAmmessi: [
        'minibus', 'bus'
      ]
    }),
    ['minibus']
  );
});

test('Gruppo con restrizioni differenti', () => {
  assert.deepEqual(
    restrizioniGruppoNcc([
      {
        origineTipiVeicoloAmmessi: [
          'van', 'minibus'
        ]
      },
      {
        destinazioneTipiVeicoloAmmessi: [
          'minibus', 'bus'
        ]
      }
    ]),
    ['minibus']
  );
});

test('Compatibilita categoria e capienza', () => {
  assert.deepEqual(
    veicoliCompatibiliNcc(
      flotta,
      ['van', 'minibus'],
      10
    ).map(v => v.id),
    [6]
  );
});

test('Nessun veicolo compatibile', () => {
  assert.deepEqual(
    veicoliCompatibiliNcc(
      flotta,
      ['auto', 'berlina'],
      12
    ),
    []
  );
});

assert.equal(superati, 20);

console.log(
  '\nTEST COMPATIBILITA SUPERATI:',
  superati,
  '/ 20'
);

console.log('V290.2E.2C TEST COMPLETATI');
