import { pool } from '../db/db.js';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { setupSocket } from '../socket.js';

async function eseguiTestSogliaAttivazione() {
  const httpServer = createServer();
  const io = new Server(httpServer);
  setupSocket(io);

  const client = await pool.connect();
  console.log('🧪 [TEST] Avvio test isolato per la soglia di attivazione segmenti...');

  let direttriceGenerataId = null;

  try {
    await client.query('BEGIN');

    const slotFuturo = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    
    // 🧹 Pulizia preventiva per evitare conflitti di unicità
    await client.query(`DELETE FROM richieste_pop_bus WHERE prezzo IN (100.00, 2.00)`);
    await client.query(`
      DELETE FROM direttrici_virtuali 
      WHERE partenza_prevista::date = $1::date
    `, [slotFuturo]);

    console.log(`📌 [TEST SETUP] Slot pulito. Inserimento richieste di test in_attesa per lo slot: ${slotFuturo}`);

    // 1. Richiesta 1 (Tratta 1->2): Prezzo alto (100€) -> Segmento attivo
    const req1Res = await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, posti_richiesti, prezzo, stato, start_datetime, direttrice_id)
      VALUES (1, 2, 5, 100.00, 'in_attesa', $1, NULL)
      RETURNING id
    `, [slotFuturo]);
    const idReq1 = req1Res.rows[0].id;

    // 2. Richiesta 2 (Tratta 2->3): Posti in eccesso (50) -> Segmento bloccato/in_attesa
    const req2Res = await client.query(`
      INSERT INTO richieste_pop_bus (start_node_id, end_node_id, posti_richiesti, prezzo, stato, start_datetime, direttrice_id)
      VALUES (2, 3, 50, 2.00, 'in_attesa', $1, NULL)
      RETURNING id
    `, [slotFuturo]);
    const idReq2 = req2Res.rows[0].id;

    await client.query('COMMIT');
    console.log('🛠️ [TEST SETUP] Richieste inserite e commit effettuato.');

    console.log('🚀 [TEST] Esecuzione di processaProposteDinamiche()...');
    await processaProposteDinamiche();

    // Recuperiamo l'ultima direttrice creata
    const { rows: dirTrovata } = await client.query(`
      SELECT id, tipo_servizio FROM direttrici_virtuali 
      ORDER BY id DESC LIMIT 1
    `);

    if (dirTrovata.length === 0) {
      console.error('❌ [TEST ERRORE] Nessuna direttrice trovata nel database.');
      return;
    }

    direttriceGenerataId = dirTrovata[0].id;
    const tipoServizioDir = dirTrovata[0].tipo_servizio;
    console.log(`🔍 [TEST VERIFICA] Trovata ultima direttrice ID: ${direttriceGenerataId} (Servizio: ${tipoServizioDir})`);

    // 📋 Dettaglio richieste pop_bus collegate
    const { rows: dettagliRichieste } = await client.query(`
      SELECT id, start_node_id, end_node_id, posti_richiesti, prezzo, stato, direttrice_id 
      FROM richieste_pop_bus 
      WHERE id = ANY($1)
      ORDER BY id ASC
    `, [[idReq1, idReq2]]);

    console.log('\n📋 [TEST DETTAGLIO] Richieste PopBus inserite in origine:');
    console.log('--------------------------------------------------------------------------------');
    dettagliRichieste.forEach(r => {
      console.log(`   ➔ Richiesta ID: ${r.id}`);
      console.log(`     - Tratta           : Node ${r.start_node_id} -> Node ${r.end_node_id}`);
      console.log(`     - Posti Richiesti  : ${r.posti_richiesti}`);
      console.log(`     - Prezzo Offerto   : ${r.prezzo} €`);
      console.log(`     - Stato Attuale    : [**${r.stato.toUpperCase()}**]`);
      console.log(`     - Direttrice Assoc.: ID ${r.direttrice_id !== null ? r.direttrice_id : 'Nessuna'}`);
      console.log('--------------------------------------------------------------------------------');
    });

    // Recuperiamo i dettagli estesi dei segmenti con informazioni di soglia/capienza
    const { rows: verifiche } = await client.query(`
      SELECT id, start_node_id, end_node_id, stato, ricavo_stimato, posti_occupati 
      FROM segmenti 
      WHERE direttrice_id = $1
      ORDER BY id ASC
    `, [direttriceGenerataId]);

    console.log('\n📊 [TEST RISULTATI & DETTAGLIO SOGLIE/POSTI]:');
    console.log('--------------------------------------------------------------------------------');
    verifiche.forEach(s => {
      const statoFormatted = s.stato.toUpperCase() === 'ATTIVO' ? '[**ATTIVO**]' : '[**IN_ATTESA**]';
      console.log(`   ➔ Segmento ${s.start_node_id} -> ${s.end_node_id} (ID: ${s.id})`);
      console.log(`     - Stato Esito       : ${statoFormatted}`);
      console.log(`     - Ricavo Stimato    : ${s.ricavo_stimato !== null ? s.ricavo_stimato + ' €' : 'N.D. (Sotto soglia o non calcolato)'}`);
      console.log(`     - Posti Occupati    : ${s.posti_occupati} posti`);
      console.log(`     - Verifica Capienza : ${s.posti_occupati <= 30 ? '✅ Entro i limiti flotta' : '❌ Superamento capienza massima flotta'}`);
      console.log('--------------------------------------------------------------------------------');
    });

    const segA = verifiche.find(s => s.start_node_id === 1 && s.end_node_id === 2);
    const segB = verifiche.find(s => s.start_node_id === 2 && s.end_node_id === 3);

    const testPassato = segA && segA.stato === 'attivo' && segB && segB.stato === 'in_attesa';

    if (testPassato) {
      console.log('\n🎉 **TEST SUPERATO CON SUCCESSO AL 100%!** Il motore ha validato correttamente la soglia economica e il vincolo di capienza.');
    } else {
      console.log('\n⚠️ **TEST FALLITO:** Il comportamento dei segmenti non corrisponde alle attese economiche.');
    }

  } catch (err) {
    console.error('❌ [TEST ERRORE CRITICO]', err);
  } finally {
    // Pulizia finale
    try {
      await client.query(`DELETE FROM richieste_pop_bus WHERE prezzo IN (100.00, 2.00)`);
      if (direttriceGenerataId) {
        await client.query(`DELETE FROM offerte_autisti WHERE direttrice_id = $1`, [direttriceGenerataId]).catch(() => {});
        await client.query(`DELETE FROM segmenti WHERE direttrice_id = $1`, [direttriceGenerataId]);
        await client.query(`DELETE FROM direttrici_virtuali WHERE id = $1`, [direttriceGenerataId]);
      }
    } catch (e) {
      console.error('⚠️ [TEST CLEANUP ERROR]', e);
    }
    client.release();
    httpServer.close();
    await pool.end();
    process.exit();
  }
}

eseguiTestSogliaAttivazione();