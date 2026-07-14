import { getIO } from '../../socket.js';
import { getDestinatariDispatching } from './fleetMatchingService.js';
import { pool } from '../../db/db.js';

export async function dispatchDirettriciAttive(tratteAttivate, client = pool) {
  const activeDirIds = [...new Map(tratteAttivate.map(t => [t.direttrice_id, t])).values()];

  for (const t of activeDirIds) {
    await client.query(`UPDATE direttrici_virtuali SET stato = 'in_attesa_autista' WHERE id = $1`, [t.direttrice_id]);
    
    const { rows: meta } = await client.query(`
      SELECT d.tipo_servizio, s.posti_occupati
      FROM direttrici_virtuali d
      JOIN segmenti s ON s.direttrice_id = d.id
      WHERE d.id = $1
    `, [t.direttrice_id]);
    
    const destinatari = await getDestinatariDispatching(t.direttrice_id);
    
    const payloadProposta = {
      direttrice_id: t.direttrice_id,
      classe: meta[0]?.tipo_servizio || 'urbano',
      posti_richiesti: meta[0]?.posti_occupati || 0
    };

    for (const dest of destinatari) {
      if (dest.driver_id) {
        getIO().to(`driver_${dest.driver_id}`).emit('nuova_proposta_popbus', payloadProposta);
      }
    }
  }

  return activeDirIds.length;
}