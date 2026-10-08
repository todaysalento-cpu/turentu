import test from 'node:test';
import assert from 'node:assert';
import { setupSocket } from '../socket.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';

test('Test di integrazione: richieste sovrapposte, gestione segmenti e missioni di ritorno', async () => {
  console.log('🏁 [TEST INTEGRATION] Avvio test richieste sovrapposte e missioni di ritorno...');

  try {
    const mockIo = { to: () => ({ emit: () => {} }), use: () => {}, on: () => {} };
    setupSocket(mockIo);
  } catch (e) {}

  const client = await pool.connect();
  
  try {
    // 1. Inseriamo nodi sequenziali di test (501 -> 502 -> 503 -> 504)
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES 
      (501, ST_SetSRID(ST_MakePoint(12.60, 42.00), 4326), 0),
      (502, ST_SetSRID(ST_MakePoint(12.61, 42.01), 4326), 0),
      (503, ST_SetSRID(ST_MakePoint(12.62, 42.02), 4326), 0),
      (504, ST_SetSRID(ST_MakePoint(12.63, 42.03), 4326), 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Inseriamo richieste sovrapposte nello stesso slot orario
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99940, 502, 503, 2, '2026-06-03 09:00:00+02', 'in_attesa', 25.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99941, 501, 504, 3, '2026-06-03 09:00:00+02', 'in_attesa', 50.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    console.log('📥 [Test] Inserite richieste sovrapposte 502->503 e 501->504. Esecuzione worker...');
    
    // 3. Esecuzione del worker
    await processaProposteDinamiche();

    // 4. Verifiche strutturali della direttrice
    const { rows: direttrici } = await client.query(`
      SELECT id, start_node_id, end_node_id, tipo_servizio, stato 
      FROM direttrici_virtuali 
      WHERE start_node_id = 501 AND end_node_id = 504
    `);

    assert.strictEqual(direttrici.length, 1, 'Deve esistere esattamente una direttrice principale unificata 501->504');
    const direttriceId = direttrici[0].id;

    // 5. Verifiche sui segmenti creati e il loro stato
    const { rows: segmenti } = await client.query(`
      SELECT id, start_node_id, end_node_id, stato, ricavo_stimato 
      FROM segmenti 
      WHERE direttrice_id = $1
      ORDER BY start_node_id ASC
    `, [direttriceId]);

    console.log('📊 [Test] Segmenti associati alla direttrice:', segmenti);
    assert.ok(segmenti.length >= 3, 'Devono essere stati creati i segmenti della direttrice');

    // 6. VERIFICHE SPECIFICHE SULLE MISSIONI DI RITORNO
    const { rows: missioniRitorno } = await client.query(`
      SELECT mr.id, mr.segmento_id, mr.stato, s.start_node_id, s.end_node_id
      FROM missioni_ritorno mr
      JOIN segmenti s ON mr.segmento_id = s.id
      WHERE mr.direttrice_id = $1
    `, [direttriceId]);

    console.log('📋 [Test] Stato missioni di ritorno generate:', missioniRitorno);
    assert.ok(missioniRitorno.length > 0, 'Devono esistere missioni di ritorno collegate alla direttrice');

    // Tutte le missioni di ritorno collegate ai segmenti devono mantenere lo stato originario 'in_attesa'
    const missioniInAttesa = missioniRitorno.filter(m => m.stato === 'in_attesa');
    console.log(`🔄 [Test] Missioni di ritorno rimaste in_attesa sui segmenti: ${missioniInAttesa.length}`);
    assert.strictEqual(
      missioniInAttesa.length, 
      missioniRitorno.length, 
      'Tutte le missioni di ritorno devono rimanere legate ai rispettivi segmenti con stato in_attesa'
    );

    console.log('✅ [TEST INTEGRATION] Test completato con successo (missioni di ritorno correttamente preservate sui segmenti)!');

  } catch (error) {
    console.error('❌ [TEST INTEGRATION ERROR]', error);
    throw error;
  } finally {
    // 7. Pulizia sicura dei dati di test
    console.log('🧹 [TEST INTEGRATION] Pulizia dati di test...');
    await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id = 501 AND end_node_id = 504);`);
    await client.query(`DELETE FROM missioni_ritorno WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id = 501 AND end_node_id = 504);`);
    await client.query(`DELETE FROM segmenti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id = 501 AND end_node_id = 504);`);
    await client.query(`DELETE FROM richieste_pop_bus WHERE id IN (99940, 99941);`);
    await client.query(`DELETE FROM direttrici_virtuali WHERE start_node_id = 501 AND end_node_id = 504;`);
    await client.query(`DELETE FROM nodi_direttrice WHERE id BETWEEN 501 AND 504;`);
    client.release();
    console.log('🔄 [TEST INTEGRATION] Pulizia completata.');
  }
});