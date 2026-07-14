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

async function eseguiTestCompatibilitaTemporale() {
  console.log('🧪 [TEST] Avvio test di compatibilità temporale e slot orari...');

  const originalConnect = pool.connect;
  let queryEseguite = [];
  let direttriciGenerate = [];

  // 1. Setup mock socket
  const mockIoServer = {
    use: () => {},
    on: () => {},
    emit: () => {}
  };
  setupSocket(mockIoServer);

  // 2. Simuliamo richieste con slot orari differenti per testare l'isolamento temporale
  const richiesteTemporaliMock = [
    { start_node_id: 1, end_node_id: 2, classe: 'STANDARD', slot_orario: '2026-07-13T14:00:00.000Z', posti_totali: 4, dist_km: 3.2 },
    { start_node_id: 1, end_node_id: 2, classe: 'STANDARD', slot_orario: '2026-07-13T16:00:00.000Z', posti_totali: 2, dist_km: 3.2 }
  ];

  let idCounter = 300;

  pool.connect = async () => {
    return {
      query: async (sql, params) => {
        const cleanSql = sql.trim().replace(/\s+/g, ' ');
        queryEseguite.push({ sql: cleanSql, params });

        if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
          console.log('\n  ⏳ [DB MOCK] Richieste con slot temporali differenti rilevate:');
          richiesteTemporaliMock.forEach(r => {
            console.log(`    Slot: ${r.slot_orario} | Tratta: ${r.start_node_id} -> ${r.end_node_id} | Posti: ${r.posti_totali}`);
          });
          return { rows: richiesteTemporaliMock };
        }
        if (cleanSql.includes('INSERT INTO direttrici_virtuali')) {
          const nuovaDir = { id: idCounter++, partenza_prevista: params[0], start_node_id: params[1], end_node_id: params[2] };
          direttriciGenerate.push(nuovaDir);
          return { rows: [{ id: nuovaDir.id }] };
        }
        if (cleanSql.includes('INSERT INTO segmenti') && cleanSql.includes('RETURNING id')) {
          return { rows: [{ id: 500 + queryEseguite.length }] };
        }
        if (cleanSql.includes('RETURNING s.direttrice_id, s.stato')) {
          return {
            rows: direttriciGenerate.map(d => ({ direttrice_id: d.id, stato: 'attivo' }))
          };
        }
        if (cleanSql.includes('SELECT tipo_servizio FROM direttrici_virtuali')) {
          return { rows: [{ tipo_servizio: 'urbano' }] };
        }

        return { rows: [] };
      },
      release: () => {}
    };
  };

  try {
    console.log('\n--- TEST: Separazione delle direttrici basata sullo slot orario ---');
    await processaProposteDinamiche();

    // Verifiche di isolamento temporale
    assert(direttriceGenerataDistinta(direttriciGenerate, '2026-07-13T14:00:00.000Z'), 'Creata direttrice per le 14:00');
    assert(direttriceGenerataDistinta(direttriciGenerate, '2026-07-13T16:00:00.000Z'), 'Creata direttrice separata per le 16:00');
    assert(direttriciGenerate.length === 2, 'Il numero di direttrici corrisponde agli slot temporali distinti');

  } catch (err) {
    console.error('❌ [TEST TEMPORALE FALLITO]:', err);
  } finally {
    pool.connect = originalConnect;
  }

  console.log(`\n📊 Risultati Test Compatibilità Temporale: ${testPassati}/${testTotali} superati.`);
}

function direttriceGenerataDistinta(lista, orario) {
  return lista.some(d => d.partenza_prevista === orario);
}

eseguiTestCompatibilitaTemporale();