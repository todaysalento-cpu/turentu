import { pool } from '../db/db.js';
import { gestisciMatchingEDirettrici } from '../services/popbus/directiveMatcher.js';

async function runTest() {
  let client;
  try {
    client = await pool.connect();
    console.log('🔌 Connesso al database di test tramite il Pool.');

    // 1. Pulizia preventiva dell'ambiente
    console.log('🧹 Pulizia tabelle...');
    await client.query(`
      TRUNCATE TABLE missioni_ritorno, richieste_pop_bus, segmenti, direttrici_virtuali, nodi_direttrice 
      RESTART IDENTITY CASCADE;
    `);

    // 2. Inserimento Nodi di base estesi (0, 1, 2, 3, 4, 5, 7, 8)
    console.log('📍 Inserimento nodi geografici di base ed estesi (0 ➔ 8)...');
    await client.query(`
      INSERT INTO nodi_direttrice (id, posizione, offset_metri) VALUES
      (0, ST_SetSRID(ST_MakePoint(18.0500, 40.2500), 4326), 0), -- Nodo 0 (Retroestensione)
      (1, ST_SetSRID(ST_MakePoint(18.1000, 40.3000), 4326), 0), -- Nodo 1 (A)
      (2, ST_SetSRID(ST_MakePoint(18.1500, 40.3500), 4326), 0), -- Nodo 2 (B)
      (3, ST_SetSRID(ST_MakePoint(18.2000, 40.4000), 4326), 0), -- Nodo 3 (C)
      (4, ST_SetSRID(ST_MakePoint(18.2500, 40.4500), 4326), 0), -- Nodo D
      (5, ST_SetSRID(ST_MakePoint(18.3000, 40.5000), 4326), 0), -- Nodo E
      (7, ST_SetSRID(ST_MakePoint(18.4000, 40.6000), 4326), 0), -- Nodo 7 (Disgiunto Start)
      (8, ST_SetSRID(ST_MakePoint(18.4500, 40.6500), 4326), 0);  -- Nodo 8 (Disgiunto End)
    `);

    // --- STEP 1: Richiesta Base (1 ➔ 3) ---
    console.log('\n📥 STEP 1: Inserimento Richiesta Base (Nodo 1 ➔ Nodo 3)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo) VALUES
      (1, 3, '2026-10-12 17:00:00+00', 2, 'in_attesa', 10.00);
    `);
    await gestisciMatchingEDirettrici(client, [{
      start_node_id: 1, end_node_id: 3, slot_orario: '2026-10-12T17:00:00.000Z', posti_totali: 2, dist_km: 10.0, fascia_percorrenza: 'media', is_composta: false
    }]);

    // --- STEP 2: Richiesta Interna / Sovrapposta (2 ➔ 3) ---
    console.log('\n📥 STEP 2: Inserimento Richiesta Interna (Nodo 2 ➔ Nodo 3)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo) VALUES
      (2, 3, '2026-10-12 17:02:00+00', 1, 'in_attesa', 4.00);
    `);
    await gestisciMatchingEDirettrici(client, [{
      start_node_id: 2, end_node_id: 3, slot_orario: '2026-10-12T17:00:00.000Z', posti_totali: 1, dist_km: 4.0, fascia_percorrenza: 'media', is_composta: false
    }]);

    // --- STEP 3: Estensione in Avanti (3 ➔ 5) ---
    console.log('\n📥 STEP 3: Inserimento Estensione in Avanti (Nodo 3 ➔ Nodo 5)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo) VALUES
      (3, 5, '2026-10-12 17:05:00+00', 2, 'in_attesa', 12.00);
    `);
    await gestisciMatchingEDirettrici(client, [{
      start_node_id: 3, end_node_id: 5, slot_orario: '2026-10-12T17:00:00.000Z', posti_totali: 2, dist_km: 12.0, fascia_percorrenza: 'media', is_composta: false
    }]);

    // --- STEP 4: Retroestensione / Estensione all'indietro (0 ➔ 1) ---
    console.log('\n📥 STEP 4: Inserimento Retroestensione (Nodo 0 ➔ Nodo 1)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo) VALUES
      (0, 1, '2026-10-12 16:55:00+00', 1, 'in_attesa', 5.00);
    `);
    await gestisciMatchingEDirettrici(client, [{
      start_node_id: 0, end_node_id: 1, slot_orario: '2026-10-12T17:00:00.000Z', posti_totali: 1, dist_km: 5.0, fascia_percorrenza: 'media', is_composta: false
    }]);

    // --- STEP 5: Richiesta Non Contigua nello stesso slot (7 ➔ 8) ---
    console.log('\n📥 STEP 5: Inserimento Richiesta Non Contigua (Nodo 7 ➔ Nodo 8)...');
    await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo) VALUES
      (7, 8, '2026-10-12 17:00:00+00', 2, 'in_attesa', 10.00);
    `);
    await gestisciMatchingEDirettrici(client, [{
      start_node_id: 7, end_node_id: 8, slot_orario: '2026-10-12T17:00:00.000Z', posti_totali: 2, dist_km: 10.0, fascia_percorrenza: 'media', is_composta: false
    }]);

    // --- VERIFICA FINALE ---
    const { rows: direttriciFinali } = await client.query(`
      SELECT id, start_node_id, end_node_id, tipo_servizio, stato FROM direttrici_virtuali
    `);

    const { rows: segmentiFinali } = await client.query(`
      SELECT id, direttrice_id, start_node_id, end_node_id, posti_occupati, ordine_sequenziale 
      FROM segmenti ORDER BY direttrice_id, ordine_sequenziale
    `);

    const { rows: richiesteFinali } = await client.query(`
      SELECT id, start_node_id, end_node_id, direttrice_id, stato FROM richieste_pop_bus
    `);

    console.log('\n🚌 Direttrici virtuali finali:');
    console.table(direttriciFinali);

    console.log('\n📏 Segmenti atomici e macro risultanti:');
    console.table(segmentiFinali);

    console.log('\n📊 Stato richieste aggiornato:');
    console.table(richiesteFinali);

    console.log('\n✅ Test completo superato con successo!');

  } catch (err) {
    console.error('❌ Errore durante l\'esecuzione del test:', err);
  } finally {
    if (client) {
      client.release();
      console.log('🔌 Connessione rilasciata al pool.');
    }
    await pool.end();
    console.log('🔌 Test terminato.');
  }
}

runTest();