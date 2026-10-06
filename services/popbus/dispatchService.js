import { getIO } from '../../socket.js';
import { getDestinatariDispatching } from './fleetMatchingService.js';
import { pool } from '../../db/db.js';

export async function dispatchDirettriciAttive(tratteAttivate, client = pool) {
  console.log(`🚚 [DISPATCH] Avvio processo di dispatch per ${tratteAttivate.length} segmenti attivati.`);

  // Estrae gli ID unici delle direttrici da processare
  const activeDirIds = [...new Map(tratteAttivate.map(t => [t.direttrice_id, t])).values()];
  console.log(`🚚 [DISPATCH] Direttrici uniche unificate da dispatchare:`, activeDirIds.map(t => t.direttrice_id));

  for (const t of activeDirIds) {
    console.log(`\n----------------------------------------`);
    console.log(`🚚 [DISPATCH] Elaborazione Direttrice ID: ${t.direttrice_id}`);

    // 1. Aggiornamento stato direttrice
    await client.query(
      `UPDATE direttrici_virtuali SET stato = 'in_attesa_autista' WHERE id = $1`, 
      [t.direttrice_id]
    );
    console.log(`🚚 [DISPATCH] Stato direttrice ${t.direttrice_id} aggiornato a 'in_attesa_autista'.`);
    
    // 2. Recupero metadati (servizio e posti occupati)
    const { rows: meta } = await client.query(`
      SELECT d.tipo_servizio, s.posti_occupati
      FROM direttrici_virtuali d
      JOIN segmenti s ON s.direttrice_id = d.id
      WHERE d.id = $1
    `, [t.direttrice_id]);
    
    console.log(`🚚 [DISPATCH] Metadati recuperati per direttrice ${t.direttrice_id}:`, meta[0] || 'Nessun metadato trovato');

    // 3. Ricerca destinatari idonei tramite fleet matching
    console.log(`🚚 [DISPATCH] Chiamata getDestinatariDispatching per direttrice ${t.direttrice_id}...`);
    const destinatari = await getDestinatariDispatching(t.direttrice_id, client);
    console.log(`🚚 [DISPATCH] Trovati ${destinatari.length} destinatari/autisti idonei per il dispatch.`);

    const payloadProposta = {
      direttrice_id: t.direttrice_id,
      classe: meta[0]?.tipo_servizio || 'urbano',
      posti_richiesti: meta[0]?.posti_occupati || 0
    };

    // 4. Invio notifiche via Socket.io ai driver in linea
    if (destinatari.length === 0) {
      console.warn(`⚠️ [DISPATCH WARNING] Nessun destinatario trovato a cui inviare la proposta per la direttrice ${t.direttrice_id}.`);
    }

    for (const dest of destinatari) {
      if (dest.driver_id) {
        const roomName = `driver_${dest.driver_id}`;
        console.log(`📡 [SOCKET] Invio evento 'nuova_proposta_popbus' alla room '${roomName}' (Payload:`, payloadProposta, `)`);
        
        getIO().to(roomName).emit('nuova_proposta_popbus', payloadProposta);
      } else {
        console.warn(`⚠️️ [DISPATCH WARNING] Trovato record destinatario senza driver_id valido:`, dest);
      }
    }
  }

  console.log(`\n----------------------------------------`);
  console.log(`✨ [DISPATCH] Dispatch completato con successo per tutte le ${activeDirIds.length} direttrici.`);
  return activeDirIds.length;
}