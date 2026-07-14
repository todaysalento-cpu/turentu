import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';
import { pool } from '../db/db.js';
import { setupSocket } from '../socket.js';

let testPassati = 0;
let testTotali = 0;

function assert(condizione, messaggio) {
  testTotali++;
  if (condizione) {
    testPassati++;
    console.log(`  ✅ [PASS] ${messaggio}`);
  } else {
    console.error(`  ❌ [FAIL] ${messaggio}`);
  }
}

async function eseguiTestAttivazioneDispatch() {
  console.log('🧪 [TEST] Avvio verifica logica Attivazione e Dispatch in processaProposteDinamiche...\n');
  const originalConnect = pool.connect;

  let eventiSocketRicevuti = [];
  const mockIoServer = {
    use: () => {},
    on: () => {},
    emit: (ev, dati) => { eventiSocketRicevuti.push({ evento: ev, dati }); },
    to: (room) => ({ emit: (ev, dati) => { eventiSocketRicevuti.push({ room, evento: ev, dati }); } })
  };
  setupSocket(mockIoServer);

  let queryEseguite = [];

  pool.connect = async () => ({
    query: async (sql, params) => {
      const cleanSql = sql.trim().replace(/\s+/g, ' ');
      queryEseguite.push({ sql: cleanSql, params });

      if (cleanSql.includes('FROM richieste_pop_bus r') && cleanSql.includes('GROUP BY')) {
        return { rows: [
          { start_node_id: 1, end_node_id: 2, classe: 'STANDARD', slot_orario: '2026-07-13T14:00:00.000Z', posti_totali: 4, dist_km: 5.0 }
        ]};
      }
      if (cleanSql.includes('INSERT INTO direttrici_virtuali')) return { rows: [{ id: 501 }] };
      if (cleanSql.includes('INSERT INTO segmenti')) return { rows: [{ id: 601 }] };
      if (cleanSql.includes('INSERT INTO missioni_ritorno')) return { rows: [] };
      
      // Fase 2: Calcolo Attivazione - simula il ritorno dei segmenti attivati
      if (cleanSql.includes('RETURNING s.id, s.direttrice_id, s.stato')) {
        return { rows: [{ id: 601, direttrice_id: 501, stato: 'attivo' }] };
      }
      
      // Fase 4: Dispatch - recupero metadati e update stato
      if (cleanSql.includes('SELECT tipo_servizio FROM direttrici_virtuali')) {
        return { rows: [{ tipo_servizio: 'scolastico' }] };
      }
      
      return { rows: [] };
    },
    release: () => {}
  });

  try {
    await processaProposteDinamiche();

    // Verifiche attivazione
    const queryAttivazione = queryEseguite.find(q => q.sql.includes('UPDATE segmenti s') && q.sql.includes('RETURNING s.id, s.direttrice_id, s.stato'));
    assert(queryAttivazione !== undefined, 'Query di calcolo attivazione ed aggiornamento segmenti eseguita');
    assert(queryAttivazione?.sql.includes('calculated_start'), 'Logica di partizione e somma dei tempi stimati inclusa');

    // Verifiche dispatch
    const queryStatoAutista = queryEseguite.find(q => q.sql.includes("SET stato = 'in_attesa_autista'"));
    assert(queryStatoAutista !== undefined, 'Stato direttrice aggiornato correttamente a in_attesa_autista');
    assert(queryStatoAutista?.params[0] === 501, 'ID direttrice passato correttamente come parametro di update');

    // Verifiche evento socket
    assert(eventiSocketRicevuti.length === 1, 'Un evento WebSocket emesso per la tratta attivata');
    assert(eventiSocketRicevuti[0]?.evento === 'nuova_proposta_popbus', 'Nome evento socket corretto');
    assert(eventiSocketRicevuti[0]?.dati?.direttrice_id === 501, 'Payload socket contiene il corretto direttrice_id');
    assert(eventiSocketRicevuti[0]?.dati?.classe === 'scolastico', 'Payload socket mappa correttamente il tipo di servizio');

  } catch (err) {
    console.error('❌ [TEST ATTIVAZIONE E DISPATCH FALLITO]:', err);
  } finally {
    pool.connect = originalConnect;
  }

  console.log(`\n📊 Risultati Test Attivazione e Dispatch: ${testPassati}/${testTotali} superati.`);
}

eseguiTestAttivazioneDispatch();