
// TURENTU PIXEL - pubblicazione manuale di snapshot.
// Nessuno scheduler e nessun POPBUS.
//
// Modalita operativa predefinita: ROLLBACK_ONLY.
// LIVE richiede autorizzazione esplicita.
//
// Supporto E2E:
// eseguiPixelInTransazione() utilizza una transazione
// PostgreSQL gia aperta dal chiamante.
// Non esegue BEGIN, COMMIT, ROLLBACK o release().

import { pool } from '../../db/db.js';
import { costruisciBootstrapPixel } from './pixel.orchestrator.service.js';
import { pubblicaOpportunitaPixel } from './pixel.persistence.service.js';

const check = (ok, msg) => {
  if (!ok) {
    throw new Error(`PIXEL_OPERATIONAL: ${msg}`);
  }
};

const PIXEL_OPERATIONAL_LOCK =
  'turentu:pixel:operational:snapshot:v1';

/**
 * Esegue il bootstrap e la pubblicazione PIXEL
 * utilizzando una transazione esterna.
 *
 * IMPORTANTE:
 * - Il chiamante deve aver gia aperto una transazione.
 * - Il chiamante possiede il client PostgreSQL.
 * - Non esegue COMMIT o ROLLBACK.
 * - Non rilascia il client.
 * - Non attiva POPBUS.
 *
 * L'orchestratore E2E deve utilizzare:
 *
 * BEGIN ISOLATION LEVEL REPEATABLE READ
 *
 * e deve eseguire ROLLBACK al termine.
 */
export async function eseguiPixelInTransazione({
  client,
  now = new Date(),
  maxRichieste = 100,
  maxDirettrici = 500,
  abilitaVariantiP1 = true,
  bufferMinuti = 0
} = {}) {
  check(
    client && typeof client.query === 'function',
    'client PostgreSQL transazionale obbligatorio'
  );

  // Serializza gli snapshot PIXEL anche fra processi Node.
  // Il lock viene rilasciato automaticamente al termine
  // della transazione posseduta dal chiamante.
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [PIXEL_OPERATIONAL_LOCK]
  );

  const { engine, riepilogo } = await costruisciBootstrapPixel({
    client,
    now,
    maxRichieste,
    maxDirettrici,
    abilitaVariantiP1,
    bufferMinuti
  });

  check(
    engine.mutationQueueState().pending === 0,
    'mutazioni PIXEL ancora in corso'
  );

  const pubblicazioni = [];

  for (const corridor of engine.listCorridors()) {
    const published = await pubblicaOpportunitaPixel({
      engine,
      direttriceId: corridor.id,
      bufferMinuti,
      client
    });

    pubblicazioni.push({
      engineId: `territorial:${corridor.nodes.join('>')}`,
      ...published
    });
  }

  return {
    mode: 'E2E_ROLLBACK',
    committed: false,
    richiesteEsaminate: riepilogo.richiesteEsaminate,
    direttriciRipristinate: riepilogo.direttriciRipristinate,
    direttriciRisultanti: riepilogo.direttriciRisultanti,
    nuoveDirettrici: riepilogo.nuoveDirettrici,
    opportunitaCandidate: riepilogo.opportunitaCandidate,
    direttriciPubblicate: pubblicazioni.length,
    pubblicazioni
  };
}

/**
 * Entry point operativo PIXEL.
 *
 * ROLLBACK_ONLY:
 *   costruisce e pubblica lo snapshot, poi annulla
 *   tutte le modifiche PostgreSQL.
 *
 * LIVE:
 *   esegue COMMIT soltanto con autorizzazione.
 *
 * Il comportamento pubblico rimane invariato.
 */
export async function processaPixelOperativo({
  mode = 'ROLLBACK_ONLY',
  now = new Date(),
  maxRichieste = 100,
  maxDirettrici = 500,
  abilitaVariantiP1 = true,
  bufferMinuti = 0
} = {}) {
  check(
    mode === 'ROLLBACK_ONLY' || mode === 'LIVE',
    'modalita non valida'
  );

  if (mode === 'LIVE') {
    check(
      process.env.PIXEL_OPERATIONAL_LIVE_APPROVED === '1',
      'LIVE non autorizzato'
    );
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    // Snapshot coerente anche durante il routing asincrono.
    await client.query(
      'BEGIN ISOLATION LEVEL REPEATABLE READ'
    );
    transactionOpen = true;

    const result = await eseguiPixelInTransazione({
      client,
      now,
      maxRichieste,
      maxDirettrici,
      abilitaVariantiP1,
      bufferMinuti
    });

    if (mode === 'ROLLBACK_ONLY') {
      await client.query('ROLLBACK');
      transactionOpen = false;

      return {
        ...result,
        mode: 'ROLLBACK_ONLY',
        committed: false
      };
    }

    await client.query('COMMIT');
    transactionOpen = false;

    return {
      ...result,
      mode: 'LIVE',
      committed: true
    };

  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(
          '[PIXEL OPERATIONAL] rollback fallito',
          rollbackError
        );
      }
    }

    throw error;

  } finally {
    client.release();
  }
}
