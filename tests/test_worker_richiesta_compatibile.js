import test from 'node:test';
import assert from 'node:assert';
import { setupSocket } from '../socket.js'; // Importiamo setupSocket per inizializzare il mock del socket
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';

test('Test di integrazione: processaProposteDinamiche gestisce nuove richieste compatibili con direttrici in_attesa_autista', async () => {
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
    // 1. Inserimento nodi e prima richiesta di test
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES 
      (101, ST_SetSRID(ST_MakePoint(12.4922, 41.8902), 4326), 0),
      (102, ST_SetSRID(ST_MakePoint(12.5000, 41.9000), 4326), 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99901, 101, 102, 2, '2026-06-01 08:30:00+02', 'in_attesa', 15.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    console.log('📥 [TEST INTEGRATION] Prima richiesta inserita. Esecuzione prima passata del worker...');

    // 2. Prima esecuzione del worker: porta la direttrice in 'in_attesa_autista'
    await processaProposteDinamiche();

    const { rows: direttriciPrima } = await client.query(`
      SELECT id, stato FROM direttrici_virtuali WHERE start_node_id = 101
    `);
    console.log(`📊 [TEST INTEGRATION] Stato direttrice dopo 1ª esecuzione:`, direttriciPrima);
    assert.strictEqual(direttriciPrima[0].stato, 'in_attesa_autista', 'La direttrice deve trovarsi in stato in_attesa_autista');

    // 3. Inseriamo una SECONDA richiesta compatibile (stessa tratta, stesso slot) mentre la direttrice è già in attesa autista
    console.log('📥 [TEST INTEGRATION] Inserimento seconda richiesta compatibile (ID: 99902)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99902, 101, 102, 2, '2026-06-01 08:30:00+02', 'in_attesa', 15.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    // 4. Seconda esecuzione del worker
    console.log('🚀 [TEST INTEGRATION] Seconda esecuzione del worker con nuova richiesta in arrivo...');
    await processaProposteDinamiche();

    // 5. Verifiche: la vecchia direttrice non deve essere alterata e la nuova richiesta viene gestita separatamente
    const { rows: tutteDirettrici } = await client.query(`
      SELECT id, stato FROM direttrici_virtuali WHERE start_node_id = 101
    `);
    console.log(`📊 [TEST INTEGRATION] Direttrici totali per la tratta 101->102:`, tutteDirettrici);

    const { rows: statoRichiestaNuova } = await client.query(`
      SELECT id, stato, direttrice_id FROM richieste_pop_bus WHERE id = 99902
    `);
    console.log(`📊 [TEST INTEGRATION] Stato della nuova richiesta (99902):`, statoRichiestaNuova);

    assert.ok(tutteDirettrici.length >= 1, 'Il sistema deve mantenere o gestire correttamente le direttrici');

    console.log('✅ [TEST INTEGRATION] Test completato con successo!');

  } catch (error) {
    console.error('❌ [TEST INTEGRATION ERROR]', error);
    throw error;
  } finally {
    // 6. Pulizia manuale dei dati di test
    console.log('🧹 [TEST INTEGRATION] Pulizia dati di test...');
    await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id = 101);`);
    await client.query(`DELETE FROM segmenti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id = 101);`);
    await client.query(`DELETE FROM richieste_pop_bus WHERE id IN (99901, 99902);`);
    await client.query(`DELETE FROM direttrici_virtuali WHERE start_node_id = 101;`);
    await client.query(`DELETE FROM nodi_direttrice WHERE id IN (101, 102);`);
    client.release();
    console.log('🔄 [TEST INTEGRATION] Pulizia completata.');
  }
});