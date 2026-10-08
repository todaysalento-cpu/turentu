import test from 'node:test';
import assert from 'node:assert';
import { setupSocket } from '../socket.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';

test('Test di integrazione: gestione segmenti contenuti e sovrapposti', async () => {
  console.log('🏁 [TEST INTEGRATION] Avvio test segmenti contenuti/sovrapposti...');

  try {
    const mockIo = { to: () => ({ emit: () => {} }), use: () => {}, on: () => {} };
    setupSocket(mockIo);
  } catch (e) {}

  const client = await pool.connect();
  
  try {
    // 1. Inseriamo nodi sequenziali (301 -> 302 -> 303 -> 304)
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES 
      (301, ST_SetSRID(ST_MakePoint(12.40, 41.80), 4326), 0),
      (302, ST_SetSRID(ST_MakePoint(12.41, 41.81), 4326), 0),
      (303, ST_SetSRID(ST_MakePoint(12.42, 41.82), 4326), 0),
      (304, ST_SetSRID(ST_MakePoint(12.43, 41.83), 4326), 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Inseriamo la prima richiesta sulla tratta interna 302 -> 303 (richiesta da 2 posti)
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99920, 302, 303, 2, '2026-06-01 11:00:00+02', 'in_attesa', 12.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    console.log('📥 [TEST INTEGRATION] Richiesta interna (302->303) inserita. Esecuzione worker...');
    await processaProposteDinamiche();

    // Verifichiamo il primo segmento
    const { rows: segmentiFase1 } = await client.query(`
      SELECT id, direttrice_id, start_node_id, end_node_id, stato, posti_occupati 
      FROM segmenti 
      WHERE start_node_id = 302 AND end_node_id = 303
    `);
    
    assert.strictEqual(segmentiFase1.length, 1, 'Deve esistere il segmento 302->303');
    assert.strictEqual(segmentiFase1[0].stato, 'attivo', 'Il segmento 302->303 deve essere attivo');
    assert.strictEqual(segmentiFase1[0].posti_occupati, 2, 'I posti occupati devono essere 2');

    const direttriceIdFase1 = segmentiFase1[0].direttrice_id;

    // 3. Inseriamo una seconda richiesta più ampia che CONTIENE la prima: 301 -> 304 (richiesta da 4 posti)
    console.log('📥 [TEST INTEGRATION] Inserimento richiesta contenitrice più ampia (301->304)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99921, 301, 304, 4, '2026-06-01 11:00:00+02', 'in_attesa', 25.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    // Eseguiamo nuovamente il worker
    await processaProposteDinamiche();

    // 4. Verifichiamo come il sistema gestisce la sovrapposizione/contenimento
    const { rows: tuttiSegmenti } = await client.query(`
      SELECT id, direttrice_id, start_node_id, end_node_id, stato, posti_occupati 
      FROM segmenti 
      WHERE start_node_id >= 301 AND end_node_id <= 304
      ORDER BY start_node_id ASC, end_node_id ASC
    `);

    console.log('📊 [TEST INTEGRATION] Segmenti dopo la richiesta contenitrice:', tuttiSegmenti);

    // Asserzioni strutturali per verificare la gestione della tratta contenuta vs contenitrice
    assert.ok(tuttiSegmenti.length >= 2, 'Devono essere presenti più segmenti per coprire la sovrapposizione');

    console.log('✅ [TEST INTEGRATION] Test sui segmenti contenuti completato con successo!');

  } catch (error) {
    console.error('❌ [TEST INTEGRATION ERROR]', error);
    throw error;
  } finally {
    // 5. Pulizia
    console.log('🧹 [TEST INTEGRATION] Pulizia dati di test...');
    await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id BETWEEN 301 AND 304);`);
    await client.query(`DELETE FROM segmenti WHERE start_node_id BETWEEN 301 AND 304;`);
    await client.query(`DELETE FROM richieste_pop_bus WHERE id IN (99920, 99921);`);
    await client.query(`DELETE FROM direttrici_virtuali WHERE start_node_id BETWEEN 301 AND 304;`);
    await client.query(`DELETE FROM nodi_direttrice WHERE id BETWEEN 301 AND 304;`);
    client.release();
    console.log('🔄 [TEST INTEGRATION] Pulizia completata.');
  }
});