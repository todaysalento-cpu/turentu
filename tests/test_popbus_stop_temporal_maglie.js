
import assert from 'node:assert/strict';
import { verificaCompatibilitaTemporaleFermate }
  from '../services/popbus/v2/popbus-stop-temporal.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');
const TOLLERANZA_MS = 10 * 60 * 1000;
const DURATA_STRADALE_MS = 138 * 1000;

function creaItinerario(ritardoMinuti) {
  const salita = BASE + ritardoMinuti * 60000;

  return {
    ok: true,
    visite: [
      {
        fermata_id: 14,
        arrivo: salita,
        eventi: [
          {
            tipo: 'salita',
            richiesta_id: 900001,
            timestampOperazione: salita
          }
        ]
      },
      {
        fermata_id: 15,
        arrivo: salita + DURATA_STRADALE_MS,
        eventi: [
          {
            tipo: 'discesa',
            richiesta_id: 900001,
            timestampOperazione:
              salita + DURATA_STRADALE_MS
          }
        ]
      }
    ]
  };
}

const richieste = [
  {
    id: 900001,
    start_datetime: new Date(BASE).toISOString()
  }
];

function test(nome, ritardo, atteso) {
  const risultato = verificaCompatibilitaTemporaleFermate({
    itinerario: creaItinerario(ritardo),
    richieste,
    tolleranzaMs: TOLLERANZA_MS
  });

  assert.equal(risultato.ok, atteso, nome);

  console.log({
    test: nome,
    compatibile: risultato.ok,
    motivo: risultato.motivo ?? null,
    differenzaMinuti: risultato.dettagli[0]?.differenzaMinuti
  });
}

console.log('=== POPBUS V2 - TEST TEMPORALE MAGLIE ===');
console.log('Durata routing 14 -> 15: 138 secondi');
console.log('Tolleranza di test: 10 minuti');

test('Salita puntuale', 0, true);
test('Salita entro tolleranza', 8, true);
test('Salita fuori tolleranza', 12, false);
test('Salita anticipata entro tolleranza', -8, true);
test('Salita anticipata fuori tolleranza', -12, false);

console.log('\nPASS: tutti i controlli temporali superati.');
