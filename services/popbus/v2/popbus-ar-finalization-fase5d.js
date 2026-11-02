// TURENTU POPBUS V2 - FASE 5D (SCAFFOLD OFFLINE)
// NON collegare al router. NON abilita richieste A/R in acceptance.js.
// Questo modulo verifica esclusivamente il confine transazionale e il protocollo
// delle callback. Non costituisce un finalizzatore di produzione.

function fail(message) {
  const error = new Error(message);
  error.code = 'AR_FINALIZATION_NOT_READY';
  error.status = 409;
  return error;
}

/**
 * @param {object} deps
 * @param {object} deps.client - client PostgreSQL dedicato, non condiviso
 * @param {function} deps.preflight - (client, rootId) => analisi
 * @param {function} deps.convert - (client, activationId) => risultato conversione
 * @param {function} deps.finalize - (client, analisi, risultati) => void
 * @param {number} deps.rootId
 * @returns {Promise<object>} esito da pubblicare SOLO dopo il commit
 *
 * Le callback sono INIEZIONI PER TEST. Non esporre questa funzione via HTTP.
 * L'implementazione reale dovra' integrare l'acceptance protetta, i lock
 * deterministici, l'identita' delle offerte e la verifica di tutte le richieste.
 */
export async function provaFinalizzazioneAR({client, preflight, convert, finalize, rootId}) {
  if (!client || typeof client.query !== 'function' ||
      typeof preflight !== 'function' || typeof convert !== 'function' ||
      typeof finalize !== 'function' ||
      !Number.isSafeInteger(Number(rootId)) || Number(rootId) <= 0) {
    throw fail('Parametri non validi');
  }

  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    // Il preflight deve acquisire il lock globale e i lock delle righe.
    const analysis = await preflight(client, Number(rootId));
    if (analysis?.stato !== 'pronta' ||
        !Array.isArray(analysis.attivazioni) || analysis.attivazioni.length < 2 ||
        !Array.isArray(analysis.gruppi) || analysis.gruppi.length === 0 ||
        analysis.anomalie?.length) {
      throw fail('Preflight A/R non pronto');
    }
    const ids = analysis.attivazioni.map(Number);
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(ids).size !== ids.length) {
      throw fail('Attivazioni non valide o duplicate');
    }
    // Ordine stabile, indispensabile per ridurre conflitti tra transazioni.
    ids.sort((a, b) => a - b);
    const results = [];
    for (const id of ids) {
      const result = await convert(client, id);
      if (!result || result.giaAccettata === true) {
        throw fail(`Conversione attivazione ${id} non valida`);
      }
      results.push({attivazioneId: id, result});
    }
    await finalize(client, analysis, results);
    await client.query('COMMIT');
    inTransaction = false;
    return {stato: 'committed', results};
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
}
