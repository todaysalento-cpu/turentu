import { pool } from '../db/db.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { setupSocket } from '../socket.js';

async function testCompatibilitaOrariaTransitoCompleto() {
  const httpServer = createServer();
  const io = new Server(httpServer);
  setupSocket(io);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('🧹 Pulizia dati di test precedenti...');
    await client.query("DELETE FROM offerte_autisti");
    await client.query("DELETE FROM missioni_ritorno");
    await client.query("DELETE FROM richieste_pop_bus");
    await client.query("DELETE FROM segmenti");
    await client.query("DELETE FROM direttrici_virtuali");

    console.log('🏗️ Creazione direttrice e segmento di riferimento (Partenza ore 10:00)...');
    const { rows: dirRes } = await client.query(`
      INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
      VALUES ('in_formazione', '2026-06-01 10:00:00', 1, 2, 'STANDARD_media')
      RETURNING id
    `);
    const direttriceEsistenteId = dirRes[0].id;

    // Transito al Nodo 2 = 10:20
    await client.query(`
      INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati, stato, ordine_sequenziale, tempo_stimato)
      VALUES ($1, 1, 2, 5, 'attivo', 1, 20)
    `, [direttriceEsistenteId]);

    console.log('📥 1. Inserimento richiesta COMPATIBILE (Transito stimato 10:20, Richiesta ore 10:30 - Delta 10 min < 40 min)...');
    const { rows: reqComp } = await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo)
      VALUES (2, 3, '2026-06-01 10:30:00', 2, 'in_attesa', 15.00)
      RETURNING id
    `);
    const idReqCompatibile = reqComp[0].id;

    console.log('📥 2. Inserimento richiesta NON COMPATIBILE (Richiesta ore 12:00 - Delta > 40 min)...');
    const { rows: reqNonComp } = await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, start_datetime, posti_richiesti, stato, prezzo)
      VALUES (2, 3, '2026-06-01 12:00:00', 2, 'in_attesa', 15.00)
      RETURNING id
    `);
    const idReqNonCompatibile = reqNonComp[0].id;

    await client.query('COMMIT');
    console.log('✅ Setup di test completato.');

    console.log('🔄 Esecuzione worker processaProposteDinamiche()...');
    await processaProposteDinamiche();

    // Verifiche finali
    const { rows: direttriciFinali } = await client.query('SELECT id, start_node_id, end_node_id, partenza_prevista FROM direttrici_virtuali ORDER BY id ASC');
    console.log('📌 Direttrici presenti nel DB dopo l\'elaborazione:', direttriciFinali);

    const { rows: richiesteAggiornate } = await client.query('SELECT id, start_node_id, end_node_id, direttrice_id, stato FROM richieste_pop_bus ORDER BY id ASC');
    console.log('📌 Stato richieste:', richiesteAggiornate);

    const dirReqComp = richiesteAggiornate.find(r => r.id === idReqCompatibile)?.direttrice_id;
    const dirReqNonComp = richiesteAggiornate.find(r => r.id === idReqNonCompatibile)?.direttrice_id;

    const testRiuso = (dirReqComp === direttriceEsistenteId);
    const testSeparazione = (dirReqNonComp && dirReqNonComp !== direttriceEsistenteId);

    if (direttriciFinali.length === 2 && testRiuso && testSeparazione) {
      console.log('🎉 TEST SUPERATO AL 100%:' );
      console.log('   - La richiesta compatibile ha riusato la direttrice esistente.');
      console.log('   - La richiesta non compatibile ha generato una nuova direttrice separata.');
    } else {
      console.log('⚠️ TEST FALLITO: Il comportamento delle direttrici non rispecchia le attese temporali.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Errore durante il test:', err);
  } finally {
    client.release();
    httpServer.close();
    process.exit();
  }
}

testCompatibilitaOrariaTransitoCompleto();