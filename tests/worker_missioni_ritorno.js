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

async function eseguiTestMissioniRitorno() {
  console.log('🧪 [TEST] Avvio verifica logica missioni_ritorno in processaProposteDinamiche...\n');
  const originalConnect = pool.connect;

  // Setup socket mock
  setupSocket({
    use: () => {},
    on: () => {},
    emit: () => {},
    to: () => ({ emit: () => {} })
  });

  let chiamateMissioni = [];

  pool.connect = async () => ({
    query: async (sql, params) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      
      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: [
          { start_node_id: 100, end_node_id: 200, classe: 'STANDARD', slot_orario: '2026-07-13T14:00:00.000Z', posti_totali: 5, dist_km: 6.0 }
        ]};
      }
      if (cleanSql.includes('INSERT INTO direttrici_virtuali')) {
        return { rows: [{ id: 777 }] };
      }
      if (cleanSql.includes('INSERT INTO segmenti')) {
        return { rows: [{ id: 888 }] };
      }
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) {
        chiamateMissioni.push({ sql: cleanSql, params });
        return { rows: [] };
      }
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) {
        return { rows: [{ id: 888, direttrice_id: 777, stato: 'attivo' }] };
      }
      if (cleanSql.includes('SELECT tipo_servizio FROM direttrici_virtuali')) {
        return { rows: [{ tipo_servizio: 'urbano' }] };
      }
      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();

    const qMissione = chiamateMissioni[0];

    // Verifiche strutturali sulla query di missioni_ritorno
    assert(chiamateMissioni.length === 1, 'Eseguito l\'inserimento della missione di ritorno');
    assert(qMissione?.params[0] === 888, 'Il segmento_id ($1) è associato correttamente');
    assert(qMissione?.params[1] === 777, 'La direttrice_id ($2) è associata correttamente');
    assert(qMissione?.params[2] === 200 && qMissione?.params[3] === 200, 'Nodo origine e capolinea finale ($3, $4) mappati sul capolinea d\'arrivo');
    assert(qMissione?.params[4] === '2026-07-13T14:00:00.000Z', 'Orario base slot passato correttamente ($5)');
    assert(qMissione?.sql.includes("INTERVAL '1 hour'"), 'Aggiunto l\'intervallo di 1 ora per l\'orario previsto');
    assert(qMissione?.sql.includes("ON CONFLICT (segmento_id, capolinea_finale_id) DO NOTHING"), 'Gestione dei conflitti configurata in modo sicuro (DO NOTHING)');

  } catch (err) {
    console.error('❌ [TEST MISSIONI RITORNO FALLITO]:', err);
  } finally {
    pool.connect = originalConnect;
  }

  console.log(`\n📊 Risultati Test Missioni Ritorno: ${testPassati}/${testTotali} superati.`);
}

eseguiTestMissioniRitorno();