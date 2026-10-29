// TURENTU A/R STEP 3 - servizio di stato (nessuna cattura Stripe).
// Il chiamante gestisce BEGIN/COMMIT/ROLLBACK e passa il client PostgreSQL.
// NON utilizzare questo modulo da solo per dichiarare una prenotazione confermata.
const STATES = new Set(['preparazione','in_autorizzazione','autorizzato','in_attesa','pronto','confermato','annullamento_richiesto','annullato','scaduto','errore']);
const TRANSITIONS = Object.freeze({
  preparazione: ['in_autorizzazione','annullamento_richiesto','errore'],
  in_autorizzazione: ['autorizzato','annullamento_richiesto','errore'],
  autorizzato: ['in_attesa','annullamento_richiesto','scaduto','errore'],
  in_attesa: ['pronto','annullamento_richiesto','scaduto','errore'],
  pronto: ['confermato','annullamento_richiesto','scaduto','errore'],
  confermato: [], annullamento_richiesto: ['annullato','errore'],
  annullato: [], scaduto: [], errore: ['annullamento_richiesto']
});

export async function getArGroupForUpdate(client, groupId, clienteId = null) {
  const result = await client.query(
    `SELECT * FROM public.ar_gruppi WHERE id = $1 AND ($2::bigint IS NULL OR cliente_id = $2) FOR UPDATE`,
    [groupId, clienteId]
  );
  if (result.rowCount !== 1) {
    const e = new Error('Gruppo A/R inesistente o non accessibile'); e.status = 404; throw e;
  }
  return result.rows[0];
}

export async function transitionArGroup(client, groupId, expectedState, nextState, clienteId = null) {
  if (!STATES.has(expectedState) || !STATES.has(nextState) ||
      !TRANSITIONS[expectedState].includes(nextState)) {
    const e = new Error(`Transizione A/R non consentita: ${expectedState} -> ${nextState}`);
    e.status = 409; throw e;
  }
  const group = await getArGroupForUpdate(client, groupId, clienteId);
  if (group.stato !== expectedState) {
    const e = new Error(`Stato A/R cambiato: atteso ${expectedState}, attuale ${group.stato}`);
    e.status = 409; throw e;
  }
  if (new Date(group.expires_at).getTime() <= Date.now() &&
      !['scaduto','annullamento_richiesto','annullato','errore'].includes(nextState)) {
    const e = new Error('Autorizzazione A/R scaduta'); e.status = 409; throw e;
  }
  const result = await client.query(
    `UPDATE public.ar_gruppi SET stato = $2, updated_at = now() WHERE id = $1 AND stato = $3 RETURNING *`,
    [groupId, nextState, expectedState]
  );
  if (result.rowCount !== 1) throw new Error('Aggiornamento concorrente A/R non riuscito');
  return result.rows[0];
}

export async function assertArCaptureAllowed(client, groupId) {
  const group = await getArGroupForUpdate(client, groupId);
  // Fail-closed: solo il coordinatore completo potrà attivare la cattura.
  // Anche "confermato" non basta: occorre verificare le due missioni e PI reali.
  const error = new Error(`Cattura A/R disabilitata nello STEP 3 (stato=${group.stato})`);
  error.status = 409;
  error.code = 'AR_CAPTURE_NOT_READY';
  throw error;
}
