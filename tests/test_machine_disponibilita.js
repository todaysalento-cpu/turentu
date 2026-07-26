import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { pool } from '../db/db.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';

describe('Test Suite: Matching e Attivazione con Disponibilità Veicolo Reale', () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('DELETE FROM direttrici_richieste');
    await client.query('DELETE FROM missioni_ritorno');
    await client.query('DELETE FROM segmenti');
    await client.query('DELETE FROM richieste_pop_bus');
    await client.query('DELETE FROM direttrici_virtuali');
    await client.query('DELETE FROM tariffe');
    await client.query('DELETE FROM veicolo');
    await client.query('DELETE FROM nodi_direttrice');
  });

  afterEach(async () => {
    if (client) {
      client.release();
    }
  });

  test('Dovrebbe interrogare la disponibilità reale dei veicoli e tariffe dal DB per determinare l attivazione', async () => {
    console.log('\n--- [TEST SETUP] Inserimento Nodi Geografici ---');
    const { rows: nodi } = await client.query(`
      INSERT INTO nodi_direttrice (nome_nodo, posizione, offset_metri) VALUES 
      ('Partenza - Terminal 1', ST_SetSRID(ST_MakePoint(16.8719, 41.1171), 4326)::geography, 0),
      ('Arrivo - Terminal 2', ST_SetSRID(ST_MakePoint(16.9719, 41.1171), 4326)::geography, 0)
      RETURNING id, nome_nodo
    `);
    const nodeA = nodi[0].id;
    const nodeB = nodi[1].id;
    console.log(`✅ Nodi creati: [ID: ${nodeA}] -> [ID: ${nodeB}]`);

    console.log('\n--- [TEST SETUP] Inserimento Veicolo e Tariffa Reali nel DB ---');
    const { rows: veicolo } = await client.query(`
      INSERT INTO veicolo (modello, posti_totali, targa, rating) 
      VALUES ('Iveco Daily Pop', 30, 'FX777WZ', 4.9) 
      RETURNING id, modello, posti_totali
    `);
    const veicoloId = veicolo[0].id;
    const euroKmReale = 0.40;

    await client.query(`
      INSERT INTO tariffe (veicolo_id, euro_km) VALUES ($1, $2)
    `, [veicoloId, euroKmReale]);

    console.log(`✅ Veicolo reale inserito -> ID: ${veicoloId}, Modello: ${veicolo[0].modello}, Posti: ${veicolo[0].posti_totali}`);
    console.log(`✅ Tariffa chilometrica letta dal DB -> ${euroKmReale} €/km`);

    console.log('\n--- [TEST SETUP] Inserimento Richieste Utente (Input) ---');
    const slotOrario = '2026-08-01 12:00:00+00';
    const { rows: richieste } = await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, classe, stato) 
      VALUES 
      ($1, $2, $3, 10, 'STANDARD', 'in_attesa'),
      ($1, $2, $3, 15, 'SAVER', 'in_attesa')
      RETURNING id, posti_richiesti, classe
    `, [nodeA, nodeB, slotOrario]);

    richieste.forEach(r => {
      console.log(`📥 Richiesta registrata -> ID: ${r.id} | Posti: ${r.posti_richiesti} | Classe: ${r.classe}`);
    });

    console.log('\n--- [TEST EXECUTION] Esecuzione Worker con Matching Reale ---');
    await processaProposteDinamiche();
    console.log('✨ Elaborazione worker completata.');

    console.log('\n--- [TEST VERIFICATION] Risultati sul Database ---');
    const { rows: segmenti } = await client.query('SELECT id, stato, posti_occupati, ricavo_stimato FROM segmenti');
    assert.strictEqual(segmenti.length, 1, 'Il segmento deve essere stato creato');
    
    console.log(`🚀 Segmento Operativo Verificato -> ID: ${segmenti[0].id}`);
    console.log(`   - Stato: ${segmenti[0].stato}`);
    console.log(`   - Posti Totali Accumulati: ${segmenti[0].posti_occupati} (10 + 15)`);
    console.log(`   - Ricavo Stimato: ${segmenti[0].ricavo_stimato} €`);

    assert.strictEqual(segmenti[0].stato, 'attivo', 'Il segmento deve risultare attivo superando la soglia basata sui dati reali');
    assert.strictEqual(segmenti[0].posti_occupati, 25, 'I posti occupati devono corrispondere a 25');

    console.log('\n✅ Test superato con successo utilizzando i dati reali dal database!\n');
  });
});