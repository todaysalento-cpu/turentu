import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { pool } from '../db/db.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';

describe('Test Suite: Matching e Attivazione Proposte Dinamiche (Pop-Bus) - Dettagliato', () => {
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

  test('Dovrebbe validare dettagliatamente dati in ingresso, calcolo soglia, attivazione segmento operativo e stato finale', async () => {
    console.log('\n--- [TEST SETUP] Inserimento Nodi Geografici ---');
    const { rows: nodi } = await client.query(`
      INSERT INTO nodi_direttrice (nome_nodo, posizione, offset_metri) VALUES 
      ('Partenza - Nodo A', ST_SetSRID(ST_MakePoint(16.8719, 41.1171), 4326)::geography, 0),
      ('Arrivo - Nodo B', ST_SetSRID(ST_MakePoint(16.9719, 41.1171), 4326)::geography, 0)
      RETURNING id, nome_nodo
    `);
    const nodeA = nodi[0].id;
    const nodeB = nodi[1].id;
    console.log(`✅ Creati nodi: [ID: ${nodeA}] ${nodi[0].nome_nodo} -> [ID: ${nodeB}] ${nodi[1].nome_nodo}`);

    console.log('\n--- [TEST SETUP] Configurazione Veicolo e Tariffe ---');
    const { rows: veicolo } = await client.query(`
      INSERT INTO veicolo (modello, posti_totali, targa, rating) 
      VALUES ('Sprinter Test', 50, 'ZZ999YY', 4.8) 
      RETURNING id, modello
    `);
    const veicoloId = veicolo[0].id;
    const euroKmTariffa = 0.50;

    await client.query(`
      INSERT INTO tariffe (veicolo_id, euro_km) VALUES ($1, $2)
    `, [veicoloId, euroKmTariffa]);
    console.log(`✅ Configurato veicolo [ID: ${veicoloId}] con tariffa di riferimento: ${euroKmTariffa} €/km`);

    console.log('\n--- [TEST SETUP] Inserimento Richieste Utente (Input) ---');
    const slotOrario = '2026-08-01 10:00:00+00';
    const { rows: richiesteInserite } = await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, classe, stato) 
      VALUES 
      ($1, $2, $3, 20, 'STANDARD', 'in_attesa'),
      ($1, $2, $3, 20, 'SAVER', 'in_attesa')
      RETURNING id, posti_richiesti, classe, stato
    `, [nodeA, nodeB, slotOrario]);
    
    richiesteInserite.forEach(r => {
      console.log(`📥 Richiesta inserita -> ID: ${r.id} | Posti: ${r.posti_richiesti} | Classe: ${r.classe} | Stato: ${r.stato}`);
    });

    console.log('\n--- [TEST EXECUTION] Avvio Worker Proposte Dinamiche ---');
    await processaProposteDinamiche();
    console.log('✨ Esecuzione worker completata.');

    console.log('\n--- [TEST VERIFICATION] Controllo Risultati sul Database ---');

    // 1. Verifica Direttrice (Contenitore)
    const { rows: direttrici } = await client.query('SELECT id, stato, tipo_servizio, partenza_prevista FROM direttrici_virtuali');
    assert.strictEqual(direttrici.length, 1, 'Dovrebbe esistere esattamente 1 direttrice virtuale');
    console.log(`📂 Direttrice Contenitrice -> ID: ${direttrici[0].id} | Stato: ${direttrici[0].stato} | Partenza: ${direttrici[0].partenza_prevista}`);

    // 2. Verifica Segmento Operativo
    const { rows: segmenti } = await client.query('SELECT id, stato, posti_occupati, ricavo_stimato, start_datetime, ordine_sequenziale FROM segmenti');
    assert.strictEqual(segmenti.length, 1, 'Dovrebbe esistere esattamente 1 segmento operativo');
    
    console.log(`🚀 Segmento Operativo -> ID: ${segmenti[0].id}`);
    console.log(`    - Stato: ${segmenti[0].stato}`);
    console.log(`    - Posti Occupati Accumulati: ${segmenti[0].posti_occupati}`);
    console.log(`    - Ricavo Stimato: ${segmenti[0].ricavo_stimato} €`);
    console.log(`    - Orario Calcolato: ${segmenti[0].start_datetime}`);
    console.log(`    - Ordine Sequenziale: ${segmenti[0].ordine_sequenziale}`);

    // Asserzioni puntuali sui risultati attesi (incluso il controllo della somma andata/ritorno e soglia)
    assert.strictEqual(segmenti[0].stato, 'attivo', 'Il segmento operativo deve essere attivato dopo il superamento della soglia economica');
    assert.strictEqual(segmenti[0].posti_occupati, 40, 'Il totale dei posti occupati deve corrispondere alla somma delle richieste (20 + 20)');
    assert.strictEqual(Number(segmenti[0].ricavo_stimato), 100.00, 'Il ricavo stimato deve essere 40 posti * 2.50€ = 100.00€');
    assert.strictEqual(segmenti[0].ordine_sequenziale, 1, 'Il primo segmento della direttrice deve avere ordine sequenziale pari a 1');

    console.log('\n✅ Tutti i test e i riscontri sui dati sono stati superati con successo!\n');
  });
});