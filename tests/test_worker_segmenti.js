import test from 'node:test';
import assert from 'node:assert';
import { setupSocket } from '../socket.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';

test('Test di integrazione: verifica comportamento e creazione segmenti paralleli', async () => {
  console.log('🏁 [TEST INTEGRATION] Avvio test comportamento segmenti...');

  try {
    const mockIo = { to: () => ({ emit: () => {} }), use: () => {}, on: () => {} };
    setupSocket(mockIo);
  } catch (e) {}

  const client = await pool.connect();
  
  try {
    // 1. Inseriamo nodi per la tratta di test
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES 
      (201, ST_SetSRID(ST_MakePoint(12.49, 41.89), 4326), 0),
      (202, ST_SetSRID(ST_MakePoint(12.50, 41.90), 4326), 0),
      (203, ST_SetSRID(ST_MakePoint(12.51, 41.91), 4326), 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Inseriamo una richiesta iniziale sulla tratta 201 -> 202
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99910, 201, 202, 2, '2026-06-01 10:00:00+02', 'in_attesa', 15.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    console.log('📥 [TEST INTEGRATION] Richiesta inserita. Esecuzione worker...');
    await processaProposteDinamiche();

    // 2. Verifichiamo i segmenti creati nella prima fase
    const { rows: segmentiPrima } = await client.query(`
      SELECT id, direttrice_id, start_node_id, end_node_id, stato, posti_occupati 
      FROM segmenti 
      WHERE start_node_id = 201
    `);
    console.log('📊 [TEST INTEGRATION] Segmenti dopo la prima esecuzione:', segmentiPrima);
    assert.strictEqual(segmentiPrima.length, 1, 'Deve esistere esattamente un segmento');
    assert.strictEqual(segmentiPrima[0].stato, 'attivo', 'Il segmento deve essere nello stato attivo');
    assert.strictEqual(segmentiPrima[0].posti_occupati, 2, 'I posti occupati devono essere 2');

    const direttriceId = segmentiPrima[0].direttrice_id;

    // 3. Inseriamo una SECONDA richiesta che insiste sullo stesso segmento (201 -> 202)
    console.log('📥 [TEST INTEGRATION] Inserimento seconda richiesta sullo stesso segmento...');
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99911, 201, 202, 3, '2026-06-01 10:00:00+02', 'in_attesa', 20.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    // Eseguiamo nuovamente il worker
    await processaProposteDinamiche();

    // 4. Verifichiamo la presenza dei segmenti dopo la seconda richiesta
    const { rows: segmentiDopo } = await client.query(`
      SELECT id, direttrice_id, start_node_id, end_node_id, stato, posti_occupati 
      FROM segmenti 
      WHERE direttrice_id = $1
      ORDER BY id ASC
    `, [direttriceId]);

    console.log('📊 [TEST INTEGRATION] Segmenti dopo la seconda richiesta:', segmentiDopo);
    
    // Validazione della nuova architettura a segmenti paralleli
    assert.strictEqual(segmentiDopo.length, 2, 'Devono esistere due segmenti sulla direttrice (uno originario e uno parallelo)');
    assert.strictEqual(segmentiDopo[0].posti_occupati, 2, 'Il primo segmento deve mantenere 2 posti');
    assert.strictEqual(segmentiDopo[1].posti_occupati, 3, 'Il secondo segmento parallelo deve avere 3 posti');
    assert.strictEqual(segmentiDopo[1].stato, 'attivo', 'Anche il nuovo segmento parallelo deve attivarsi');

    console.log('✅ [TEST INTEGRATION] Test sui segmenti paralleli completato con successo!');

  } catch (error) {
    console.error('❌ [TEST INTEGRATION ERROR]', error);
    throw error;
  } finally {
    // 5. Pulizia
    console.log('🧹 [TEST INTEGRATION] Pulizia dati di test...');
    await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id = 201);`);
    await client.query(`DELETE FROM segmenti WHERE start_node_id = 201;`);
    await client.query(`DELETE FROM richieste_pop_bus WHERE id IN (99910, 99911);`);
    await client.query(`DELETE FROM direttrici_virtuali WHERE start_node_id = 201;`);
    await client.query(`DELETE FROM nodi_direttrice WHERE id IN (201, 202, 203);`);
    client.release();
    console.log('🔄 [TEST INTEGRATION] Pulizia completata.');
  }
});