import test from 'node:test';
import assert from 'node:assert';
import { setupSocket } from '../socket.js'; // Importiamo setupSocket per inizializzare il mock del socket
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';

test('Test di integrazione: processaProposteDinamiche gestisce richieste e crea direttrici per fasce orarie diverse', async () => {
  console.log('🏁 [TEST INTEGRATION] Avvio test con database reale...');

  // 0. Inizializziamo un mock di Socket.io per evitare l'errore "Socket.io non inizializzato!"
  try {
    const mockIo = {
      to: () => ({
        emit: () => {}
      }),
      use: () => {},
      on: () => {}
    };
    setupSocket(mockIo);
  } catch (e) {
    // Se già inizializzato, proseguiamo
  }

  const client = await pool.connect();
  
  try {
    // 1. Inseriamo i dati senza transazione isolata, salvando gli ID per poterli ripulire dopo
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES 
      (101, ST_SetSRID(ST_MakePoint(12.4922, 41.8902), 4326), 0),
      (102, ST_SetSRID(ST_MakePoint(12.5000, 41.9000), 4326), 0),
      (103, ST_SetSRID(ST_MakePoint(12.5100, 41.9100), 4326), 0),
      (104, ST_SetSRID(ST_MakePoint(12.5200, 41.9200), 4326), 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99901, 101, 102, 2, '2026-06-01 08:30:00+02', 'in_attesa', 15.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa';
    `);

    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99902, 103, 104, 3, '2026-06-01 19:00:00+02', 'in_attesa', 25.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa';
    `);

    console.log('📥 [TEST INTEGRATION] Nodi e richieste di test inseriti.');

    // 2. Eseguiamo la funzione del worker
    console.log('🚀 [TEST INTEGRATION] Esecuzione del worker...');
    await processaProposteDinamiche();

    // 3. Verifichiamo che siano state create le direttrici virtuali corrispondenti
    const { rows: direttriciCreate } = await client.query(`
      SELECT id, tipo_servizio, partenza_prevista, stato 
      FROM direttrici_virtuali 
      WHERE start_node_id IN (101, 103)
    `);

    console.log(`📊 [TEST INTEGRATION] Direttrici trovate nel DB dopo l'elaborazione:`, direttriciCreate);
    
    assert.ok(direttriciCreate.length > 0, 'Il worker deve aver creato almeno una direttrice virtuale');

    console.log('✅ [TEST INTEGRATION] Test completato con successo!');

  } catch (error) {
    console.error('❌ [TEST INTEGRATION ERROR]', error);
    throw error;
  } finally {
    // 4. Pulizia manuale dei dati di test (inclusi segmenti e offerte generate dal worker)
    console.log('🧹 [TEST INTEGRATION] Pulizia dati di test...');
    await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id IN (101, 103));`);
    await client.query(`DELETE FROM segmenti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id IN (101, 103));`);
    await client.query(`DELETE FROM richieste_pop_bus WHERE id IN (99901, 99902);`);
    await client.query(`DELETE FROM direttrici_virtuali WHERE start_node_id IN (101, 103);`);
    await client.query(`DELETE FROM nodi_direttrice WHERE id IN (101, 102, 103, 104);`);
    client.release();
    console.log('🔄 [TEST INTEGRATION] Pulizia completata.');
  }
});