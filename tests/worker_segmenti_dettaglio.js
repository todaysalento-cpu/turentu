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

async function eseguiTestDettaglioSegmenti() {
  console.log('🧪 [TEST] Avvio analisi dettagliata cicli segmenti in processaProposteDinamiche...\n');
  const originalConnect = pool.connect;

  // Setup socket mock
  setupSocket({
    use: () => {},
    on: () => {},
    emit: () => {},
    to: () => ({ emit: () => {} })
  });

  let chiamateSegmenti = [];
  let postiAccumulatiSimulati = 5; // Posti iniziali già presenti a database sul segmento

  pool.connect = async () => ({
    query: async (sql, params) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      
      // Simuliamo due cluster successivi che colpiscono lo stesso segmento (stessa tratta/direttrice)
      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: [
          { start_node_id: 10, end_node_id: 20, classe: 'URBANO', slot_orario: '2026-07-13T15:00:00.000Z', posti_totali: 7, dist_km: 3.5 }
        ]};
      }
      if (cleanSql.includes('INSERT INTO direttrici_virtuali')) {
        return { rows: [{ id: 999 }] };
      }
      if (cleanSql.includes('INSERT INTO segmenti')) {
        chiamateSegmenti.push({ sql: cleanSql, params });
        // Simuliamo l'effetto del DO UPDATE calcolando il nuovo totale dei posti occupati
        postiAccumulatiSimulati += params[3];
        return { rows: [{ id: 555 }] };
      }
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) return { rows: [] };
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) {
        return { rows: [{ id: 555, direttrice_id: 999, stato: 'attivo' }] };
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

    const qSegmento = chiamateSegmenti[0];
    
    // Verifiche strutturali sulla query dei segmenti
    assert(chiamateSegmenti.length === 1, 'Eseguita una sola operazione di scrittura sul segmento');
    assert(qSegmento?.params[0] === 999, 'Il segmento è associato al corretto ID direttrice ($1)');
    assert(qSegmento?.params[1] === 10 && qSegmento?.params[2] === 20, 'Nodi di start ($2) e end ($3) mappati correttamente');
    assert(qSegmento?.params[3] === 7, 'Il carico passeggeri inviato al segmento rispecchia i posti totali del cluster ($4)');
    assert(qSegmento?.sql.includes('ON CONFLICT (direttrice_id, start_node_id, end_node_id)'), 'Vincolo di unicità ON CONFLICT configurato sui campi chiave');
    assert(qSegmento?.sql.includes('DO UPDATE SET posti_occupati = segmenti.posti_occupati + EXCLUDED.posti_occupati'), 'Logica incrementale di somma posti occupati presente');
    assert(postiAccumulatiSimulati === 12, 'Somma cumulativa dei posti calcolata correttamente');

  } catch (err) {
    console.error('❌ [TEST DETTAGLIO SEGMENTI FALLITO]:', err);
  } finally {
    pool.connect = originalConnect;
  }

  console.log(`\n📊 Risultati Test Dettaglio: ${testPassati}/${testTotali} superati.`);
}

eseguiTestDettaglioSegmenti();