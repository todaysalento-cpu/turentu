// TURENTU - Test transazionale mock del writer fisico V2.
// Versione aggiornata per simulare disponibilita_veicolo e conflitti operativi.
// Nessuna connessione reale al DB. Nessuna scrittura.
// Installare il contenuto come:
// tests/test_popbus_physical_writer_transaction_mock_v2.mjs
// Eseguire:
// node tests\test_popbus_physical_writer_transaction_mock_v2.mjs

import { verificaCicloFisicoTransazionale } from '../services/popbus/v2/popbus-physical-writer-v2.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const now = Date.now() + 3600000;
const busyStart = now + 10 * 60000;
const busyEnd = now + 90 * 60000;

const richiesta = (overrides = {}) => ({
  id: 101,
  cliente_id: 20,
  stato: 'in_attesa',
  corsa_id: null,
  posti_richiesti: 1,
  prezzo: 15,
  payment_intent_id: 'pi_test_mock',
  start_datetime: new Date(now).toISOString(),
  ar_vincolata: false,
  ...overrides
});

const ciclo = {
  vehicleId: 7,
  // Dati richiesti dal preflight operativo aggiornato.
  baseOperativa: { lat: 40.1, lon: 18.1 },
  partenzaBase: busyStart,
  ritornoBase: busyEnd,
  missioni: [{
    vehicleId: 7,
    schemaVersion: 2,
    tipoItinerario: 'FERMATE_FISICHE',
    evaluation: { requests: [{ id: 101 }] },
    plan: { nodes: [11, 12], legs: [{ metres: 1000, seconds: 120 }] },
    nodiFisici: [
      { id: 11, lat: 40.1, lon: 18.1 },
      { id: 12, lat: 40.2, lon: 18.2 }
    ]
  }]
};

function makeMock({
  reserved = false,
  vehicle = true,
  requests = [richiesta()],
  stops = true,
  excluded = false,
  conflict = false,
  availability = true,
  throwAt = null
} = {}) {
  const queries = [];
  let released = 0;

  const client = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: q, params });

      if (throwAt && q.includes(throwAt)) {
        throw new Error('MOCK_QUERY_FAILURE');
      }

      if (/^SELECT richiesta_id FROM popbus_attivazione_richieste/i.test(q)) {
        return {
          rows: reserved ? [{ richiesta_id: 101 }] : []
        };
      }

      if (/^SELECT id, driver_id, posti_totali FROM veicolo/i.test(q)) {
        return {
          rows: vehicle
            ? [{ id: 7, driver_id: 8, posti_totali: 8 }]
            : []
        };
      }

      // Simula una disponibilita' giornaliera ampia e sulla stessa base.
      // start/fine sono usati dal modulo come contenitori dell'orario.
      if (/FROM disponibilita_veicolo dv JOIN veicolo v/i.test(q)) {
        return {
          rows: availability
            ? [{
                veicolo_id: 7,
                start: '2000-01-01T00:00:00+01:00',
                fine: '2000-01-01T23:59:00+01:00',
                giorni_esclusi: [],
                inattivita: [],
                lat: 40.1,
                lon: 18.1
              }]
            : []
        };
      }

      // Simula assenza/presenza di impegni sul ciclo completo.
      if (/FROM popbus_attivazioni a/i.test(q) &&
          /FROM corse c/i.test(q)) {
        return {
          rows: conflict ? [{ found: 1 }] : []
        };
      }

      if (/^SELECT \* FROM richieste_pop_bus/i.test(q)) {
        return { rows: requests };
      }

      if (/FROM public\.pixel_fermate f JOIN public\.nodi_territoriali n/i.test(q)) {
        return {
          rows: stops
            ? [
                {
                  id: 11,
                  attiva: true,
                  verificata: false,
                  nome: 'Fermata A',
                  nodo_attivo: true,
                  lat: 40.1,
                  lon: 18.1
                },
                {
                  id: 12,
                  attiva: true,
                  verificata: false,
                  nome: 'Fermata B',
                  nodo_attivo: true,
                  lat: 40.2,
                  lon: 18.2
                }
              ]
            : []
        };
      }

      if (/FROM public\.pixel_fermate f WHERE/i.test(q)) {
        return { rows: excluded ? [{ id: 11 }] : [] };
      }

      if (/^(BEGIN|ROLLBACK|SET LOCAL|SELECT pg_advisory_xact_lock)/i.test(q)) {
        return { rows: [] };
      }

      throw new Error('QUERY_NON_SIMULATA: ' + q);
    },

    release() {
      released++;
    }
  };

  return {
    pool: {
      async connect() {
        return client;
      }
    },
    queries,
    get released() {
      return released;
    }
  };
}

function assertSafety(mock, connected = true) {
  const sql = mock.queries.map(q => q.sql);

  assert(
    !sql.some(s => /^(COMMIT|INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(s)),
    'query di scrittura/COMMIT rilevata'
  );

  if (connected) {
    assert(sql[0] === 'BEGIN', 'BEGIN mancante');
    assert(sql.includes('ROLLBACK'), 'ROLLBACK mancante');
    assert(mock.released === 1, 'connessione non rilasciata una sola volta');
  } else {
    assert(sql.length === 0, 'connessione utilizzata in LIVE');
    assert(mock.released === 0, 'rilascio inatteso');
  }
}

async function expectFailure(label, options, pattern) {
  const mock = makeMock(options);
  let error;

  try {
    await verificaCicloFisicoTransazionale({
      pool: mock.pool,
      ciclo
    });
  } catch (e) {
    error = e;
  }

  assert(
    error && pattern.test(error.message),
    `${label}: errore atteso non ricevuto (${error?.message})`
  );
  assertSafety(mock);
  console.log('PASS - ' + label);
}

await expectFailure(
  'richiesta gia riservata',
  { reserved: true },
  /gia riservata/
);

await expectFailure(
  'veicolo inesistente',
  { vehicle: false },
  /veicolo o titolare/
);

await expectFailure(
  'richiesta non prenotabile',
  { requests: [richiesta({ stato: 'annullata' })] },
  /non prenotabile/
);

await expectFailure(
  'A/R incompleta',
  {
    requests: [
      richiesta({
        ar_vincolata: true,
        ar_group_id: 9,
        ar_tratta: 'andata'
      })
    ]
  },
  /A\/R incompleta/
);

await expectFailure(
  'fermata mancante',
  { stops: false },
  /non esistono nel catalogo/
);

await expectFailure(
  'fermata esclusa',
  { excluded: true },
  /fermata esclusa/
);

await expectFailure(
  'disponibilita assente',
  { availability: false },
  /non disponibile per l’intero ciclo operativo o base discordante/
);

await expectFailure(
  'conflitto operativo',
  { conflict: true },
  /conflitto con un altro impegno/
);

await expectFailure(
  'errore SQL',
  { throwAt: 'FROM public.pixel_fermate f JOIN' },
  /MOCK_QUERY_FAILURE/
);

{
  const mock = makeMock();
  let error;

  try {
    await verificaCicloFisicoTransazionale({
      pool: mock.pool,
      ciclo,
      mode: 'LIVE'
    });
  } catch (e) {
    error = e;
  }

  assert(error && /LIVE non abilitato/.test(error.message), 'LIVE non bloccato');
  assertSafety(mock, false);
  console.log('PASS - LIVE bloccato prima della connessione');
}

{
  const mock = makeMock();
  let error;

  try {
    await verificaCicloFisicoTransazionale({
      pool: mock.pool,
      ciclo
    });
  } catch (e) {
    error = e;
  }

  // Il mock fornisce dati sufficienti ai lock e al preflight operativo,
  // ma non un itinerario certificato: il writer deve rifiutare in sicurezza.
  assert(
    error && /itinerario fisico certificato assente/.test(error.message),
    'rivalidazione non raggiunta: ' + error?.message
  );

  const sql = mock.queries.map(q => q.sql);
  assert(sql.some(s => s.includes('pg_advisory_xact_lock')), 'advisory lock mancante');
  assert(sql.some(s => /FROM veicolo .*FOR UPDATE/i.test(s)), 'lock veicolo mancante');
  assert(sql.some(s => /FROM richieste_pop_bus .*FOR UPDATE/i.test(s)), 'lock richieste mancante');
  assert(sql.some(s => /FOR SHARE OF f, n/i.test(s)), 'lock fermate mancante');
  assert(
    sql.some(s => /FROM disponibilita_veicolo dv JOIN veicolo v/i.test(s)),
    'lettura disponibilita operativa mancante'
  );
  assert(
    sql.some(s => /FROM popbus_attivazioni a/i.test(s) && /FROM corse c/i.test(s)),
    'controllo conflitti operativi mancante'
  );

  assertSafety(mock);
  console.log('PASS - preflight operativo e lock fino a rivalidazione (rifiuto sicuro)');
}

console.log(
  'RISULTATO: test mock transazionali superati; NON certifica PostgreSQL reale o LIVE'
);
