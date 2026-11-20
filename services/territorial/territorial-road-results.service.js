
const ESITI = new Set([
  'raggiungibile',
  'non_raggiungibile',
  'non_valutabile'
]);

export function classificaRisultato({
  stato,
  distanza_m = null,
  durata_s = null
}) {
  if (!ESITI.has(stato)) {
    throw new Error('Stato stradale non valido');
  }

  if (stato !== 'raggiungibile') {
    if (distanza_m !== null || durata_s !== null) {
      throw new Error('Metriche non ammesse per questo stato');
    }

    return {
      stato,
      distanza_m: null,
      durata_s: null,
      entro_15_minuti: false
    };
  }

  if (
    !Number.isInteger(distanza_m) ||
    distanza_m < 0 ||
    !Number.isInteger(durata_s) ||
    durata_s < 0
  ) {
    throw new Error('Metriche stradali non valide');
  }

  return {
    stato,
    distanza_m,
    durata_s,
    entro_15_minuti: durata_s <= 900
  };
}

export async function finalizzaRisultatoStradale({
  client,
  id,
  workerId,
  risultato,
  provider = 'simulazione',
  simulazione = false
}) {
  if (!simulazione || !client) {
    throw new Error(
      'Persistenza reale disabilitata'
    );
  }

  if (!/^[1-9]\d*$/.test(String(id)) || !workerId) {
    throw new Error('Identificativi non validi');
  }

  if (provider !== 'simulazione') {
    throw new Error('Provider non consentito nel collaudo');
  }

  const classificazione = classificaRisultato(risultato);

  // Blocca la riga e verifica la proprietà.
  const acquisita = await client.query(`
    SELECT id, centro_gid, hub_id
    FROM territorial_hub_coda_stradale
    WHERE id = $1
      AND worker_id = $2
      AND stato = 'in_elaborazione'
      AND lease_expires_at > NOW()
    FOR UPDATE
  `, [id, workerId]);

  if (acquisita.rows.length !== 1) {
    throw new Error(
      'Verifica non finalizzabile: proprietà o lease non valida'
    );
  }

  const riga = acquisita.rows[0];

  // Scrittura sintetica: verrà annullata dal ROLLBACK.
  await client.query(`
    INSERT INTO territorial_hub_matrice_stradale (
      centro_gid,
      hub_id,
      distanza_stradale_m,
      durata_secondi,
      stato,
      provider,
      verificato_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (centro_gid,hub_id)
    DO UPDATE SET
      distanza_stradale_m = EXCLUDED.distanza_stradale_m,
      durata_secondi = EXCLUDED.durata_secondi,
      stato = EXCLUDED.stato,
      provider = EXCLUDED.provider,
      verificato_at = EXCLUDED.verificato_at
  `, [
    riga.centro_gid,
    riga.hub_id,
    classificazione.distanza_m,
    classificazione.durata_s,
    classificazione.stato,
    provider
  ]);

  const finale = await client.query(`
    UPDATE territorial_hub_coda_stradale
    SET stato = 'completata',
        terminato_at = NOW(),
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE id = $1
      AND worker_id = $2
      AND stato = 'in_elaborazione'
    RETURNING id, stato
  `, [id, workerId]);

  if (finale.rowCount !== 1) {
    throw new Error('Finalizzazione non riuscita');
  }

  return {
    id: String(id),
    ...classificazione,
    stato_coda: finale.rows[0].stato,
    simulazione: true
  };
}
