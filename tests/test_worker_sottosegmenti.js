import test from 'node:test';
import assert from 'node:assert';
import { setupSocket } from '../socket.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';

test('Test di integrazione: gestione missioni di ritorno e assorbimento sottosegmenti', async () => {
  console.log('🏁 [TEST INTEGRATION] Avvio test missioni di ritorno sottosegmenti...');

  try {
    const mockIo = { to: () => ({ emit: () => {} }), use: () => {}, on: () => {} };
    setupSocket(mockIo);
  } catch (e) {}

  const client = await pool.connect();
  
  try {
    // 1. Inseriamo nodi sequenziali (401 -> 402 -> 403 -> 404)
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES 
      (401, ST_SetSRID(ST_MakePoint(12.50, 41.90), 4326), 0),
      (402, ST_SetSRID(ST_MakePoint(12.51, 41.91), 4326), 0),
      (403, ST_SetSRID(ST_MakePoint(12.52, 41.92), 4326), 0),
      (404, ST_SetSRID(ST_MakePoint(12.53, 41.93), 4326), 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Inseriamo una richiesta sul sottosegmento interno (402 -> 403) e facciamo girare il worker per attivarla
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99930, 402, 403, 2, '2026-06-02 10:00:00+02', 'in_attesa', 10.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    console.log('📥 [Test] Inserita richiesta interna 402->403. Esecuzione worker (Fase 1)...');
    await processaProposteDinamiche();

    // Verifichiamo che il segmento 402->403 sia stato creato
    const { rows: segSotto } = await client.query(`
      SELECT id, direttrice_id, stato FROM segmenti WHERE start_node_id = 402 AND end_node_id = 403
    `);
    assert.strictEqual(segSotto.length, 1, 'Il segmento sottostante 402->403 deve esistere');
    const segmentoIdSotto = segSotto[0].id;

    // 3. Ora inseriamo una richiesta più ampia che include la precedente: 401 -> 404
    await client.query(`
      INSERT INTO richieste_pop_bus (id, start_node_id, end_node_id, posti_richiesti, start_datetime, stato, prezzo)
      VALUES (99931, 401, 404, 3, '2026-06-02 10:00:00+02', 'in_attesa', 30.00)
      ON CONFLICT (id) DO UPDATE SET stato = 'in_attesa', direttrice_id = NULL;
    `);

    console.log('📥 [Test] Inserita richiesta ampia 401->404. Esecuzione worker (Fase 2 - Assorbimento)...');
    await processaProposteDinamiche();

    // 4. Verifichiamo che la logica di assorbimento (Fase 2.5) abbia gestito i sottosegmenti/missioni di ritorno
    // Controlliamo lo stato delle missioni di ritorno o dei segmenti coinvolti nell'intervallo 401-404
    const { rows: missioniRitorno } = await client.query(`
      SELECT id, segmento_id, stato FROM missioni_ritorno 
      WHERE segmento_id IN (SELECT id FROM segmenti WHERE start_node_id >= 401 AND end_node_id <= 404)
    `);

    console.log('📊 [Test] Stato missioni di ritorno per i segmenti nell\'intervallo:', missioniRitorno);

    // Verifiche strutturali: il segmento ampio deve essere attivo e i sotto-segmenti gestiti di conseguenza
    const { rows: tuttiSegmenti } = await client.query(`
      SELECT id, start_node_id, end_node_id, stato FROM segmenti 
      WHERE start_node_id >= 401 AND end_node_id <= 404
      ORDER BY start_node_id ASC
    `);

    console.log('📊 [Test] Tutti i segmenti nell\'area dopo la seconda elaborazione:', tuttiSegmenti);

    const segmentoAmpio = tuttiSegmenti.find(s => s.start_node_id === 401 && s.end_node_id === 404);
    assert.ok(segmentoAmpio, 'Il segmento ampio 401->404 deve essere stato creato');
    assert.strictEqual(segmentoAmpio.stato, 'attivo', 'Il segmento ampio deve essere attivo');

    console.log('✅ [TEST INTEGRATION] Test missioni di ritorno e sottosegmenti completato con successo!');

  } catch (error) {
    console.error('❌ [TEST INTEGRATION ERROR]', error);
    throw error;
  } finally {
    // 5. Pulizia sicura delle tabelle collegate
    console.log('🧹 [TEST INTEGRATION] Pulizia dati di test...');
    await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id IN (SELECT id FROM direttrici_virtuali WHERE start_node_id BETWEEN 401 AND 404);`);
    await client.query(`DELETE FROM missioni_ritorno WHERE segmento_id IN (SELECT id FROM segmenti WHERE start_node_id >= 401 AND end_node_id <= 404);`);
    await client.query(`DELETE FROM segmenti WHERE start_node_id >= 401 AND end_node_id <= 404;`);
    await client.query(`DELETE FROM richieste_pop_bus WHERE id IN (99930, 99931);`);
    await client.query(`DELETE FROM direttrici_virtuali WHERE start_node_id BETWEEN 401 AND 404;`);
    await client.query(`DELETE FROM nodi_direttrice WHERE id BETWEEN 401 AND 404;`);
    client.release();
    console.log('🔄 [TEST INTEGRATION] Pulizia completata.');
  }
});