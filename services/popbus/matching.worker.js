import { pool } from '../../db/db.js';
import { elaboraClustering } from './clusterService.js';
import { gestisciMatchingEDirettrici } from './directiveMatcher.js';
import { calcolaAttivazioneEconomica } from './economicEngine.js';
import { assegnaVeicoliEDirettrici } from './fleetAllocator.js';
import { dispatchDirettriciAttive } from './dispatchService.js';

export async function processaProposteDinamiche() {
  const client = await pool.connect();
  console.log('🔄 [WORKER] Avvio cluster pop-bus con compatibilità spaziale e temporale...');

  try {
    await client.query('BEGIN');

    // 1. Clustering e chiusura transitiva
    const allClusters = await elaboraClustering(client);

    // 2. Matching, verifica compatibilità temporale e gestione segmenti
    const segmentiCoinvoltiIds = await gestisciMatchingEDirettrici(client, allClusters);

    if (segmentiCoinvoltiIds.length === 0) {
      console.log('⚠️ [WORKER] Nessun segmento coinvolto in questo giro. Commit e fine.');
      await client.query('COMMIT');
      return;
    }

    // 3. Calcolo economico e attivazione segmenti
    const segmentiAttivati = await calcolaAttivazioneEconomica(client, segmentiCoinvoltiIds);

    // 4. Assegnazione veicoli e aggiornamento direttrici
    if (segmentiAttivati.length > 0) {
      await assegnaVeicoliEDirettrici(client, segmentiAttivati);
    }

    // 5. Delegated Dispatch
    const countAttive = await dispatchDirettriciAttive(segmentiAttivati, client);

    await client.query('COMMIT');
    console.log(`✨ [WORKER] Transazione completata con successo. Segmenti attivi dispatchati: ${countAttive}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [WORKER ERROR] Errore critico:', err);
    throw err;
  } finally {
    client.release();
  }
}