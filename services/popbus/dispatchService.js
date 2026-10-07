import { getIO } from '../../socket.js';
import { getDestinatariDispatching } from './fleetMatchingService.js';
import { pool } from '../../db/db.js';

export async function dispatchDirettriciAttive(tratteAttivate, client = pool) {
  console.log(`🚚 [DISPATCH DEBUG] Avvio processo di dispatch per ${tratteAttivate.length} segmenti attivati.`);

  // Estrae gli ID unici delle direttrici da processare
  const activeDirIds = [...new Map(tratteAttivate.map(t => [t.direttrice_id, t])).values()];
  console.log(`🚚 [DISPATCH DEBUG] Direttrici uniche unificate da dispatchare:`, activeDirIds.map(t => t.direttrice_id));

  for (const t of activeDirIds) {
    console.log(`\n----------------------------------------`);
    console.log(`🚚 [DISPATCH DEBUG] Elaborazione Direttrice ID: ${t.direttrice_id}`);

    // 1. Aggiornamento stato direttrice
    await client.query(
      `UPDATE direttrici_virtuali SET stato = 'in_attesa_autista' WHERE id = $1`, 
      [t.direttrice_id]
    );
    console.log(`🚚 [DISPATCH DEBUG] Stato direttrice ${t.direttrice_id} aggiornato a 'in_attesa_autista'.`);
    
    // 2. Recupero metadati (servizio e posti occupati)
    const { rows: meta } = await client.query(`
      SELECT d.tipo_servizio, s.posti_occupati, d.start_node_id, d.end_node_id, d.partenza_prevista
      FROM direttrici_virtuali d
      JOIN segmenti s ON s.direttrice_id = d.id
      WHERE d.id = $1
    `, [t.direttrice_id]);
    
    console.log(`🚚 [DISPATCH DEBUG] Metadati completi recuperati per direttrice ${t.direttrice_id}:`, meta[0] || 'Nessun metadato trovato');

    // --- 🔍 DIAGNOSTICA INTERNA PER CAPIRE PERCHÉ FALLISCE IL MATCHING ---
    console.log(`🔎 [DISPATCH DIAGNOSTIC] Esecuzione query di ispezione flotte/autisti disponibili nel DB...`);
    try {
      const { rows: testTotaliAutisti } = await client.query(`SELECT COUNT(*) as tot FROM veicolo`);
      console.log(`🔎 [DISPATCH DIAGNOSTIC] Totale record nella tabella 'veicolo':`, testTotaliAutisti[0]?.tot);
    } catch (e) {
      console.log(`🔎 [DISPATCH DIAGNOSTIC] Tabella veicolo non interrogabile con questo nome o errore:`, e.message);
    }

    // 3. Ricerca destinatari idonei tramite fleet matching
    console.log(`🚚 [DISPATCH DEBUG] Chiamata getDestinatariDispatching per direttrice ${t.direttrice_id}...`);
    let destinatari = [];
    try {
      destinatari = await getDestinatariDispatching(t.direttrice_id, client);
      console.log(`🚚 [DISPATCH DEBUG] Risultato grezzo restituito da getDestinatariDispatching:`, destinatari);
    } catch (matchErr) {
      console.error(`❌ [DISPATCH ERROR] Errore durante l'esecuzione di getDestinatariDispatching:`, matchErr);
    }

    console.log(`🚚 [DISPATCH DEBUG] Trovati ${destinatari.length} destinatari/autisti idonei per il dispatch.`);

    // 4. Salvataggio nel DB (offerte_autisti) e invio notifiche via Socket.io
    if (destinatari.length === 0) {
      console.warn(`⚠️ [DISPATCH WARNING] Nessun destinatario trovato a cui inviare la proposta per la direttrice ${t.direttrice_id}.`);
    }

    for (const dest of destinatari) {
      if (dest.driver_id && dest.veicolo_id) {
        
        console.log(`💾 [DISPATCH] Tentativo di inserimento offerta per autista ID: ${dest.driver_id} (Veicolo: ${dest.veicolo_id}) sulla direttrice ${t.direttrice_id}`);

        // Salvataggio dell'offerta nel DB associata all'autista (autista_id)
        const offertaRes = await client.query(`
          INSERT INTO offerte_autisti (direttrice_id, autista_id, stato, expires_at, created_at)
          VALUES ($1, $2, 'inviata', NOW() + INTERVAL '10 minutes', NOW())
          RETURNING id
        `, [t.direttrice_id, dest.driver_id]);

        const offertaId = offertaRes.rows[0].id;
        console.log(`💾 [DISPATCH] ✅ Offerta_autisti creata con successo - ID: ${offertaId} associata all'autista ${dest.driver_id}`);

        // Usiamo 'autista_' per allinearci a socket.js (es. autista_2)
        const roomName = `autista_${dest.driver_id}`;
        
        // Payload completo con l'ID dell'offerta salvata
        const payloadProposta = {
          id: offertaId, // ID fondamentale per accettare l'offerta
          direttrice_id: t.direttrice_id,
          veicolo_id: dest.veicolo_id,
          classe: meta[0]?.tipo_servizio || 'urbano',
          posti_richiesti: meta[0]?.posti_occupati || 0
        };

        console.log(`📡 [SOCKET] Invio evento 'nuova_proposta_popbus' alla room '${roomName}' con payload:`, payloadProposta);
        
        getIO().to(roomName).emit('nuova_proposta_popbus', payloadProposta);
      } else {
        console.warn(`⚠️ [DISPATCH WARNING] Trovato record destinatario senza driver_id o veicolo_id valido:`, dest);
      }
    }
  }

  console.log(`\n----------------------------------------`);
  console.log(`✨ [DISPATCH DEBUG] Dispatch completato per tutte le ${activeDirIds.length} direttrici.`);
  return activeDirIds.length;
}