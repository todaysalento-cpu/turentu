
import { validaFermateFisicheTransazionali } from './popbus-physical-stop-lock.js';

const fail = message => {
  throw new Error(`POPBUS_PHYSICAL_WRITER_V2: ${message}`);
};

export async function verificaCicloFisicoTransazionale({
  pool,
  ciclo,
  mode = 'ROLLBACK_ONLY'
} = {}) {
  if (mode !== 'ROLLBACK_ONLY') {
    fail('LIVE non abilitato');
  }

  if (!pool || typeof pool.connect !== 'function') {
    fail('pool PostgreSQL mancante');
  }

  if (
    !ciclo ||
    !Array.isArray(ciclo.missioni) ||
    ciclo.missioni.length < 1 ||
    ciclo.missioni.length > 3
  ) {
    fail('ciclo fisico non valido');
  }

  for (const missione of ciclo.missioni) {
    if (
      missione?.schemaVersion !== 2 ||
      missione?.tipoItinerario !== 'FERMATE_FISICHE' ||
      !Array.isArray(missione.plan?.nodes) ||
      !Array.isArray(missione.nodiFisici)
    ) {
      fail('contratto missione fisica V2 incompleto');
    }
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '90s'");

    const fermate = await validaFermateFisicheTransazionali({
      client,
      missioni: ciclo.missioni
    });

    if (fermate.ok !== true) {
      fail('rivalidazione fermate fallita');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;

    return {
      ok: true,
      percorso: 'POPBUS_PHYSICAL_V2_TRANSACTION_PREFLIGHT',
      fermate,
      numeroMissioni: ciclo.missioni.length,
      dbWrites: 0,
      persistita: false,
      attivabile: false
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }

    throw error;
  } finally {
    client.release();
  }
}
