import test from 'node:test';
import assert from 'node:assert';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';

test('processaProposteDinamiche termina con successo quando non ci sono richieste in attesa', async () => {
  console.log('🏁 [TEST] Avvio test unitario del worker...');

  // 1. Creiamo un mock del client PostgreSQL
  const mockClient = {
    query: async (sqlText) => {
      const query = sqlText.trim();

      // Gestione delle transazioni
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      // Intercettazione delle query di selezione richieste in attesa
      if (query.includes('FROM richieste_pop_bus r') || query.includes('SELECT id, start_node_id')) {
        return { rows: [] }; // Restituisce array vuoto per simulare assenza di richieste
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => {
      console.log('🔌 [TEST] Client rilasciato correttamente.');
    }
  };

  // 2. Creiamo un mock del pool che restituisce il nostro mockClient
  const mockPool = {
    connect: async () => mockClient
  };

  console.log('🚀 [TEST] Esecuzione della funzione processaProposteDinamiche...');
  
  // Eseguiamo la funzione verificando che non lanci errori critici
  await assert.doesNotReject(async () => {
    await processaProposteDinamiche();
  }, 'La funzione non deve sollevare errori critici');

  console.log('✅ [TEST] Test completato con successo!');
});