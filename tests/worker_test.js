import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';
import { setupSocket } from '../socket.js';

let testPassati = 0;
let testTotali = 0;

function assert(condizione, messaggio) {
  testTotali++;
  if (condizione) {
    testPassati++;
    console.log(`  ✅ [PASS] ${messaggio}`);
  } else {
    console.error(`  ❌ [FAIL] ${messaggio}`);
  }
}

async function eseguiTestClassiMultiple() {
  console.log('🧪 [TEST] Avvio test nativo con classi e servizi multipli...');

  const originalConnect = pool.connect;
  let queryEseguite = [];
  let eventiEmessi = [];

  // 1. Configuriamo il socket per catturare tutti gli emit distinti
  const mockIoServer = {
    use: () => {},
    on: () => {},
    emit: (evento, dati) => {
      eventiEmessi.push({ evento, dati });
      console.log(`  📡 [SOCKET] Broadcast .emit('${evento}') con dati:`, dati);
    },
    to: (room) => ({
      emit: (evento, dati) => {
        eventiEmessi.push({ room, evento, dati });
        console.log(`  📡 [SOCKET] Emesso '${evento}' nella stanza '${room}' con dati:`, dati);
      }
    })
  };
  setupSocket(mockIoServer);

  // 2. Mock del DB con risposte dinamiche basate sui parametri delle query
  let chiamataMeta = 0;
  const serviziTest = ['extraurbano', 'scolastico', 'urbano'];

  // Definiamo i dati di input fittizi delle richieste da stampare a terminale
  const richiesteMockate = [
    { start_node_id: 1, end_node_id: 2, classe: 'EXTRA', slot_orario: '2026-07-13T08:00:00.000Z', posti_totali: 10, dist_km: 12.5 },
    { start_node_id: 3, end_node_id: 4, classe: 'SCHOOL', slot_orario: '2026-07-13T09:00:00.000Z', posti_totali: 15, dist_km: 8.0 },
    { start_node_id: 5, end_node_id: 6, classe: 'URB', slot_orario: '2026-07-13T10:00:00.000Z', posti_totali: 4, dist_km: 2.1 }
  ];

  pool.connect = async () => {
    return {
      query: async (sql, params) => {
        const cleanSql = sql.trim().replace(/\s+/g, ' ');
        queryEseguite.push({ sql: cleanSql, params });

        // Simula più cluster con classi differenti (Fase 1)
        if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
          console.log('\n  📋 [DB MOCK] Richieste Pop-Bus lette dal database (Clustering):');
          richiesteMockate.forEach((req, idx) => {
            console.log(`    [Richiesta ${idx + 1}] Da nodo ${req.start_node_id} a ${req.end_node_id} | Classe: ${req.classe} | Posti: ${req.posti_totali} | Distanza: ${req.dist_km} km | Slot: ${req.slot_orario}`);
          });
          return { rows: richiesteMockate };
        }
        if (cleanSql.includes('INSERT INTO direttrici_virtuali')) {
          return { rows: [{ id: 100 + queryEseguite.length }] };
        }
        if (cleanSql.includes('INSERT INTO segmenti') && cleanSql.includes('RETURNING id')) {
          return { rows: [{ id: 200 + queryEseguite.length }] };
        }
        // Restituisce multiple tratte attivate (Fase 2)
        if (cleanSql.includes('RETURNING s.direttrice_id, s.stato')) {
          return {
            rows: [
              { direttrice_id: 101, stato: 'attivo' },
              { direttrice_id: 102, stato: 'attivo' },
              { direttrice_id: 103, stato: 'attivo' }
            ]
          };
        }
        // Restituisce tipi di servizio differenti a rotazione (Fase 4)
        if (cleanSql.includes('SELECT tipo_servizio FROM direttrici_virtuali')) {
          const servizioCorrente = serviziTest[chiamataMeta % serviziTest.length];
          chiamataMeta++;
          return { rows: [{ tipo_servizio: servizioCorrente }] };
        }

        return { rows: [] };
      },
      release: () => {}
    };
  };

  try {
    console.log('\n--- TEST: Elaborazione flussi multipli con classi eterogenee ---');
    await processaProposteDinamiche();

    assert(queryEseguite.some(q => q.sql === 'BEGIN'), 'Transazione avviata (BEGIN)');
    assert(queryEseguite.some(q => q.sql === 'COMMIT'), 'Transazione confermata (COMMIT)');
    
    // Verifichiamo che siano stati emessi esattamente 3 eventi socket corrispondenti ai 3 servizi differenti
    assert(eventiEmessi.length === 3, 'Corrispondenza di tutti gli eventi socket inviati');
    assert(eventiEmessi.some(e => e.dati.classe === 'extraurbano'), 'Inviata classe extraurbano');
    assert(eventiEmessi.some(e => e.dati.classe === 'scolastico'), 'Inviata classe scolastico');
    assert(eventiEmessi.some(e => e.dati.classe === 'urbano'), 'Inviata classe urbano');

  } catch (err) {
    console.error('❌ [TEST MULTI-CLASSE FALLITO]:', err);
  } finally {
    pool.connect = originalConnect;
  }

  console.log(`\n📊 Risultati Test Classi Multiple: ${testPassati}/${testTotali} superati.`);
}

eseguiTestClassiMultiple();