import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';
import { setupSocket } from '../socket.js';

async function eseguiTestConDatiReali() {
  console.log('🚀 [TEST REALE] Avvio simulazione con ispezione dei dati a schermo...\n');
  const originalConnect = pool.connect;

  // Dati reali simulati in ingresso dal database (richieste in attesa)
  const richiesteIngressoReali = [
    { start_node_id: 12, end_node_id: 45, classe: 'extraurbano', slot_orario: '2026-07-13T16:00:00.000Z', posti_totali: 9, dist_km: 14.2 },
    { start_node_id: 88, end_node_id: 99, classe: 'scolastico', slot_orario: '2026-07-13T17:00:00.000Z', posti_totali: 22, dist_km: 9.5 }
  ];

  let logTracciamento = {
    queryEseguite: [],
    eventiSocket: []
  };

  // Setup Socket Mock con cattura dei payload
  const mockIoServer = {
    use: () => {},
    on: () => {},
    emit: (evento, dati) => {
      logTracciamento.eventiSocket.push({ tipo: 'global', evento, dati });
    },
    to: (room) => ({
      emit: (evento, dati) => {
        logTracciamento.eventiSocket.push({ tipo: 'room', room, evento, dati });
      }
    })
  };
  setupSocket(mockIoServer);

  let idDirettriceCounter = 5000;
  let idSegmentoCounter = 8000;
  let direttriciGenerate = [];

  pool.connect = async () => ({
    query: async (sql, params) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      logTracciamento.queryEseguite.push({ sql: cleanSql, params });

      // Gestione transazione fittizia
      if (cleanSql === 'BEGIN' || cleanSql === 'COMMIT' || cleanSql === 'ROLLBACK') {
        return { rows: [] };
      }

      // 1. Ritorno dei cluster raggruppati
      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: richiesteIngressoReali };
      }

      // Inserimento o Update Direttrice (garantisce sempre un array con un id valido)
      if (cleanSql.includes('INSERT INTO direttrici_virtuali') && cleanSql.includes('RETURNING id')) {
        const idDir = idDirettriceCounter++;
        direttriciGenerate.push({ id: idDir, tipo: params[3], partenza: params[0] });
        return { rows: [{ id: idDir }] };
      }

      // Inserimento Segmento
      if (cleanSql.includes('INSERT INTO segmenti')) {
        return { rows: [{ id: idSegmentoCounter++ }] };
      }

      // Inserimento Missione Ritorno
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) {
        return { rows: [] };
      }

      // Attivazione segmenti
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) {
        return { rows: direttriciGenerate.map(d => ({ id: 9999, direttrice_id: d.id, stato: 'attivo' })) };
      }

      // Aggiornamento stato direttrice per autista
      if (cleanSql.includes("SET stato = 'in_attesa_autista'")) {
        return { rows: [] };
      }

      // Recupero metadati servizi
      if (cleanSql.includes('SELECT tipo_servizio FROM direttrici_virtuali')) {
        const targetId = params?.[0];
        const trovata = direttriciGenerate.find(d => d.id === targetId);
        return { rows: [{ tipo_servizio: trovata ? trovata.tipo : 'urbano' }] };
      }

      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();

    console.log('--- 📋 DATI INGRESSO SIMULATI DAL CLUSTERING ---');
    console.table(richiesteIngressoReali);

    console.log('\n--- 🛠️ PARAMETRI REALI PASSATI ALLE QUERY SQL (Scrittura Tratte) ---');
    const scrittureTratte = logTracciamento.queryEseguite.filter(q => q.sql.includes('INSERT INTO direttrici_virtuali') && !q.sql.includes('SET stato'));
    scrittureTratte.forEach((q, idx) => {
      console.log(`[Tratta ${idx + 1}] ID Generato: ${direttriciGenerate[idx]?.id} | Partenza: ${q.params[0]} | Nodi: da ${q.params[1]} a ${q.params[2]} | Servizio: ${q.params[3]}`);
    });

    console.log('\n--- 🛰️ EVENTI WEBSOCKET EMESSI IN CLEARANCE ---');
    logTracciamento.eventiSocket.forEach((ev, idx) => {
      console.log(`[Socket Evento ${idx + 1}] Nome: '${ev.evento}'`);
      console.log('Payload trasmesso:', JSON.stringify(ev.dati, null, 2));
    });

    console.log('\n✅ [TEST REALE COMPLETATO CON SUCCESSO]');
  } catch (err) {
    console.error('❌ [ERRORE DURANTE IL TEST REALE]:', err);
  } finally {
    pool.connect = originalConnect;
  }
}

eseguiTestConDatiReali();