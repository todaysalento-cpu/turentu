import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { pool } from '../db/db.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';

describe('Test Suite: Matching e Attivazione Proposte Dinamiche (Pop-Bus) - Multi-Tratta, Chiusura Transitiva e Segmenti Interni', () => {
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

  test('Dovrebbe validare il clustering multi-tratta, la chiusura transitiva (AB + BC -> AC), la gestione dei segmenti interni e l attivazione', async () => {
    console.log('\n--- [TEST SETUP] Inserimento Nodi Geografici con Distanza Media (A -> B -> C) ---');
    // Usiamo coordinate che garantiscono una distanza totale nella fascia 'media' (20km <= dist <= 60km)
    const { rows: nodi } = await client.query(`
      INSERT INTO nodi_direttrice (nome_nodo, posizione, offset_metri) VALUES 
      ('Partenza - Nodo A', ST_SetSRID(ST_MakePoint(16.8000, 41.1171), 4326)::geography, 0),
      ('Intermedio - Nodo B', ST_SetSRID(ST_MakePoint(16.9500, 41.1171), 4326)::geography, 0),
      ('Arrivo - Nodo C', ST_SetSRID(ST_MakePoint(17.1000, 41.1171), 4326)::geography, 0)
      RETURNING id, nome_nodo
    `);
    const nodeA = nodi[0].id;
    const nodeB = nodi[1].id;
    const nodeC = nodi[2].id;
    console.log(`✅ Creati nodi: [${nodeA}] A -> [${nodeB}] B -> [${nodeC}] C`);

    console.log('\n--- [TEST SETUP] Configurazione Veicolo e Tariffe ---');
    const { rows: veicolo } = await client.query(`
      INSERT INTO veicolo (modello, posti_totali, targa, rating) 
      VALUES ('Sprinter Test', 50, 'ZZ999YY', 4.8) 
      RETURNING id
    `);
    const veicoloId = veicolo[0].id;
    const euroKmTariffa = 0.50;

    await client.query(`
      INSERT INTO tariffe (veicolo_id, euro_km) VALUES ($1, $2)
    `, [veicoloId, euroKmTariffa]);
    console.log(`✅ Configurato veicolo e tariffa (${euroKmTariffa} €/km)`);

    console.log('\n--- [TEST SETUP] Inserimento Richieste Utente (AB e BC per Chiusura Transitiva AC) ---');
    const slotOrario = '2026-08-01 10:00:00+00';
    
    await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, classe, stato) 
      VALUES 
      ($1, $2, $4, 10, 'STANDARD', 'in_attesa'),
      ($2, $3, $4, 15, 'STANDARD', 'in_attesa')
    `, [nodeA, nodeB, nodeC, slotOrario]);
    console.log('📥 Inserite richieste per AB (10 posti) e BC (15 posti) nello stesso slot.');

    console.log('\n--- [TEST EXECUTION] Avvio Worker Proposte Dinamiche con Chiusura Transitiva e Segmenti Interni ---');
    await processaProposteDinamiche();
    console.log('✨ Esecuzione worker completata.');

    console.log('\n--- [TEST VERIFICATION] Controllo Dettagliato Segmenti e Richieste Associate ---');

    const { rows: segmenti } = await client.query(`
      SELECT s.id, s.start_node_id, s.end_node_id, s.stato, s.posti_occupati, s.ricavo_stimato, s.ordine_sequenziale,
             d.id as direttrice_id, d.start_node_id as dir_start, d.end_node_id as dir_end
      FROM segmenti s
      JOIN direttrici_virtuali d ON s.direttrice_id = d.id
      ORDER BY s.ordine_sequenziale ASC, s.id ASC
    `);

    console.log(`🚀 Segmenti Operativi Totali Trovati: ${segmenti.length}`);
    for (const s of segmenti) {
      console.log(`\n    🔹 Segmento ID: ${s.id} | Tratta: ${s.start_node_id} -> ${s.end_node_id} | Ordine: ${s.ordine_sequenziale}`);
      console.log(`        Stato: ${s.stato} | Posti Occupati: ${s.posti_occupati} | Ricavo Stimato: ${s.ricavo_stimato}€`);
      console.log(`        Direttrice Madre Assegnata: ID ${s.direttrice_id} (${s.dir_start} -> ${s.dir_end})`);

      const { rows: richiesteCollegate } = await client.query(`
        SELECT r.id, r.start_node_id, r.end_node_id, r.posti_richiesti, r.classe, r.stato, r.target_missione_id
        FROM richieste_pop_bus r
        JOIN direttrici_richieste dr ON dr.richiesta_id = r.id
        WHERE dr.direttrice_id = $1
      `, [s.direttrice_id]);

      console.log(`        📋 Richieste collegate alla direttrice (${richiesteCollegate.length}):`);
      richiesteCollegate.forEach(r => {
        console.log(`          - Richiesta ID: ${r.id} | Tratta: ${r.start_node_id} -> ${r.end_node_id} | Posti: ${r.posti_richiesti} | Stato: ${r.stato} | Target Missione: ${r.target_missione_id}`);
      });
    }

    assert.ok(segmenti.length >= 2, 'Il lavoratore deve generare almeno i segmenti strutturali derivanti dallo splitting');

    const segmentoAB = segmenti.find(s => s.start_node_id === nodeA && s.end_node_id === nodeB);
    const segmentoBC = segmenti.find(s => s.start_node_id === nodeB && s.end_node_id === nodeC);
    const segmentoAC = segmenti.find(s => s.start_node_id === nodeA && s.end_node_id === nodeC);
    
    assert.ok(segmentoAB, 'Deve essere presente il segmento interno AB');
    assert.ok(segmentoBC, 'Deve essere presente il segmento residuo BC');
    assert.ok(segmentoAC, 'Deve essere presente il segmento diretto AC');
    
    // Verifiche sui ricavi stimati aggregati dei segmenti inclusi
    assert.ok(Number(segmentoAB.ricavo_stimato) >= 20.00, 'Il ricavo stimato del segmento AB deve includere la somma dei ricavi dei segmenti sottostanti');
    assert.strictEqual(segmentoAB.stato, 'attivo', 'Il segmento AB deve risultare attivo superando la soglia economica aggregata');

    console.log('\n✅ Test di splitting geometrico, dettagli segmenti e richieste verificati con successo!\n');
  });
});