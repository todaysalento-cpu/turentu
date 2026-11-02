// TURENTU POPBUS V2 - FASE 5B (PROTOTIPO OFFLINE)
// NON COLLEGARE AL ROUTER. NON USARE IN PRODUZIONE.
// Questo modulo testa solo l'orchestrazione transazionale, NON il preflight PIXEL,
// i pagamenti, la concorrenza PostgreSQL o l'autorizzazione A/R di acceptance.js.
// Tutte le dipendenze sono iniettate, cosi' i test non toccano il database.

function fail(message) {
  const e = new Error(message);
  e.code = 'AR_ATOMIC_NOT_READY';
  e.status = 409;
  return e;
}

export async function simulaFinalizzazioneAR({
  client,
  attivazioneId,
  preflight,
  converti,
  pubblicaDopoCommit = async () => {}
}) {
  if (!client?.query || !Number.isSafeInteger(attivazioneId) || attivazioneId <= 0 ||
      typeof preflight !== 'function' || typeof converti !== 'function') {
    throw fail('Parametri Fase 5B non validi');
  }
  let transactionOpen = false;
  let committed = false;
  let corse = [];
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await preflight(client, attivazioneId);
    if (result?.stato !== 'pronta' || !Array.isArray(result.attivazioniBloccate) ||
        result.attivazioniBloccate.length === 0 || result.anomalie?.length) {
      throw fail('Dipendenze A/R non pronte');
    }
    const ids = result.attivazioniBloccate;
    if (new Set(ids).size !== ids.length ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw fail('Attivazioni duplicate o non valide');
    }
    // SOLO SIMULAZIONE: converti e' una funzione iniettata nei test.
    // Il vero acceptance.js blocca le richieste A/R e NON va bypassato qui.
    for (const id of ids) {
      const corsa = await converti(client, id);
      if (!corsa?.id) throw fail(`Conversione ${id} non riuscita`);
      corse.push(corsa);
    }
    await client.query('COMMIT');
    transactionOpen = false;
    committed = true;
  } catch (e) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { e.rollbackError = rollbackError; }
    }
    throw e;
  }
  // Nessuna pubblicazione prima del COMMIT. Un errore qui non annulla il COMMIT:
  // in produzione serviranno outbox persistente e retry idempotenti.
  if (committed) await pubblicaDopoCommit(corse);
  return { stato: 'simulazione_completata', corse };
}
