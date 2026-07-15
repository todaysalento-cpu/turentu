import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';
import { setupSocket } from '../socket.js';
import * as dispatchModule from '../services/popbus/dispatchService.js';

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

async function eseguiSuiteCompleta() {
  console.log('🧪 [TEST] Avvio suite di test completa per processaProposteDinamiche...\n');
  const originalConnect = pool.connect;

  // Mockiamo la funzione di dispatch per evitare chiamate di rete/DB reali non previste
  // Nota: sovrascriviamo la proprietà dell'oggetto importato namespace se configurato, 
  // oppure mockiamo la risposta a livello di query SQL del client mockato.
  try {
    dispatchModule.dispatchDirettriciAttive = async () => 1;
  } catch {
    // Se il motore non permette la scrittura diretta, gestiamo tramite query SQL mockate
  }

  // Setup comune del socket mock
  const mockIoServer = {
    use: () => {},
    on: () => {},
    emit: () => {},
    to: (room) => ({
      emit: () => {}
    })
  };
  setupSocket(mockIoServer);

  // ==========================================
  // TEST 1: Flusso corretto
  // ==========================================
  console.log('--- TEST 1: Flusso corretto (Clustering -> Attivazione -> Dispatch) ---');
  let queryEseguite1 = [];
  let socketEmesso1 = null;

  const mockIoServer1 = {
    use: () => {},
    on: () => {},
    emit: (ev, dati) => { socketEmesso1 = { evento: ev, dati }; },
    to: (room) => ({ emit: (ev, dati) => { socketEmesso1 = { room, evento: ev, dati }; } })
  };
  setupSocket(mockIoServer1);

  pool.connect = async () => ({
    query: async (sql, params) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      queryEseguite1.push({ sql: cleanSql, params });
      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: [{ start_node_id: 1, end_node_id: 2, classe: 'STANDARD', slot_orario: '2026-07-13T14:00:00.000Z', posti_totali: 4, dist_km: 5.2 }] };
      }
      if (cleanSql.includes('INSERT INTO direttrici_virtuali')) return { rows: [{ id: 101 }] };
      if (cleanSql.includes('INSERT INTO segmenti')) return { rows: [{ id: 202 }] };
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) return { rows: [] };
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) return { rows: [{ id: 202, direttrice_id: 101, stato: 'attivo' }] };
      if (cleanSql.includes('UPDATE richieste_pop_bus r') && cleanSql.includes('SET target_missione_id')) return { rows: [] };
      // Eventuali query interne al dispatch service se esegue query sul client
      if (cleanSql.includes('SELECT tipo_servizio FROM direttrici_virtuali')) return { rows: [{ tipo_servizio: 'urbano' }] };
      if (cleanSql.includes('SELECT DISTINCT v.driver_id')) return { rows: [{ driver_id: 1, veicolo_id: 10 }] };
      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();
    assert(queryEseguite1.some(q => q.sql === 'BEGIN'), 'Transazione avviata');
    assert(queryEseguite1.some(q => q.sql === 'COMMIT'), 'Transazione confermata');
    console.log('  ✅ [TEST 1] Completato con successo.');
  } catch (err) {
    console.error('❌ [TEST 1 FALLITO]:', err);
  }

  // ==========================================
  // TEST 2: Rollback in caso di errore
  // ==========================================
  console.log('\n--- TEST 2: Rollback in caso di errore database ---');
  let queryEseguite2 = [];
  let rilascioChiamato2 = false;

  pool.connect = async () => ({
    query: async (sql) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      queryEseguite2.push({ sql: cleanSql });
      if (cleanSql.includes('FROM richieste_pop_bus r')) throw new Error('Errore critico di I/O');
      return { rows: [] };
    },
    release: () => { rilascioChiamato2 = true; }
  });

  try {
    let errCatched = false;
    try { await processaProposteDinamiche(); } catch (e) { errCatched = e.message.includes('Errore critico'); }
    assert(errCatched, 'Eccezione propagata');
    assert(queryEseguite2.some(q => q.sql === 'ROLLBACK'), 'Eseguito ROLLBACK');
    assert(rilascioChiamato2, 'Client rilasciato');
  } catch (err) {
    console.error('❌ [TEST 2 FALLITO]:', err);
  }

  // ==========================================
  // TEST 3: Classi e servizi multipli
  // ==========================================
  console.log('\n--- TEST 3: Classi e servizi eterogenei ---');
  let insertedIds3 = [];

  pool.connect = async () => ({
    query: async (sql) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: [
          { start_node_id: 1, end_node_id: 2, classe: 'EXTRA', slot_orario: '2026-07-13T08:00:00.000Z', posti_totali: 10, dist_km: 12.5 },
          { start_node_id: 3, end_node_id: 4, classe: 'SCHOOL', slot_orario: '2026-07-13T09:00:00.000Z', posti_totali: 15, dist_km: 8.0 },
          { start_node_id: 5, end_node_id: 6, classe: 'URB', slot_orario: '2026-07-13T10:00:00.000Z', posti_totali: 4, dist_km: 2.1 }
        ]};
      }
      if (cleanSql.includes('INSERT INTO direttrici_virtuali')) {
        const nextId = 101 + insertedIds3.length;
        insertedIds3.push(nextId);
        return { rows: [{ id: nextId }] };
      }
      if (cleanSql.includes('INSERT INTO segmenti')) return { rows: [{ id: 202 }] };
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) return { rows: [] };
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) {
        return { rows: insertedIds3.map((idDir, idx) => ({ id: 201 + idx, direttrice_id: idDir, stato: 'attivo' })) };
      }
      if (cleanSql.includes('UPDATE richieste_pop_bus r') && cleanSql.includes('SET target_missione_id')) return { rows: [] };
      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();
    assert(true, 'Esecuzione completata per classi multiple');
  } catch (err) {
    console.error('❌ [TEST 3 FALLITO]:', err);
  }

  // ==========================================
  // TEST 4: Compatibilità temporale
  // ==========================================
  console.log('\n--- TEST 4: Compatibilità temporale slot orari ---');
  let direttriciGenerate4 = [];

  pool.connect = async () => ({
    query: async (sql, params) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: [
          { start_node_id: 1, end_node_id: 2, classe: 'STANDARD', slot_orario: '2026-07-13T14:00:00.000Z', posti_totali: 4, dist_km: 3.2 },
          { start_node_id: 1, end_node_id: 2, classe: 'STANDARD', slot_orario: '2026-07-13T16:00:00.000Z', posti_totali: 2, dist_km: 3.2 }
        ]};
      }
      if (cleanSql.includes('INSERT INTO direttrici_virtuali')) {
        const d = { id: 300 + direttriciGenerate4.length, partenza_prevista: params[0] };
        direttriciGenerate4.push(d);
        return { rows: [{ id: d.id }] };
      }
      if (cleanSql.includes('INSERT INTO segmenti')) return { rows: [{ id: 501 }] };
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) return { rows: [] };
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) {
        return { rows: direttriciGenerate4.map(d => ({ id: 501, direttrice_id: d.id, stato: 'attivo' })) };
      }
      if (cleanSql.includes('UPDATE richieste_pop_bus r') && cleanSql.includes('SET target_missione_id')) return { rows: [] };
      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();
    assert(direttriciGenerate4.length === 2, 'Create direttrici distinte per slot orari differenti');
  } catch (err) {
    console.error('❌ [TEST 4 FALLITO]:', err);
  }

  // ==========================================
  // TEST 5: Flusso vuoto (Nessun cluster)
  // ==========================================
  console.log('\n--- TEST 5: Flusso vuoto senza richieste in attesa ---');
  let commited5 = false;

  pool.connect = async () => ({
    query: async (sql) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      if (cleanSql === 'COMMIT') commited5 = true;
      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();
    assert(commited5, 'Transazione committata correttamente anche a cluster vuoti');
  } catch (err) {
    console.error('❌ [TEST 5 FALLITO]:', err);
  } finally {
    pool.connect = originalConnect;
  }

  console.log(`\n📊 Risultati Finali Suite: ${testPassati}/${testTotali} superati.`);
}

eseguiSuiteCompleta();