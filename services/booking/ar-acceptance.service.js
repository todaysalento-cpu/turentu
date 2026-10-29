
/**
 * TURENTU — Accettazioni provvisorie A/R
 *
 * Richiede una transazione PostgreSQL già aperta.
 * Non esegue COMMIT o ROLLBACK.
 *
 * Non conferma corse, prenotazioni o pagamenti.
 */

const STATI_GRUPPO_AMMESSI = new Set([
  'autorizzato',
  'in_attesa'
]);

export async function registraAccettazioneProvvisoriaAR(
  client,
  {
    arGroupId,
    pendingId,
    veicoloId
  }
) {
  if (
    !arGroupId ||
    !Number.isSafeInteger(Number(pendingId)) ||
    Number(pendingId) <= 0 ||
    !Number.isSafeInteger(Number(veicoloId)) ||
    Number(veicoloId) <= 0
  ) {
    throw new Error('AR_ACCEPTANCE_INVALID_INPUT');
  }

  // Il chiamante deve avere già acquisito i blocchi
  // transazionali e verificato la disponibilità del veicolo.

  const gruppoResult = await client.query(
    `
    SELECT id, stato, expires_at
    FROM ar_gruppi
    WHERE id = $1
    FOR UPDATE
    `,
    [arGroupId]
  );

  const gruppo = gruppoResult.rows[0];

  if (!gruppo) {
    throw new Error('AR_GROUP_NOT_FOUND');
  }

  if (!STATI_GRUPPO_AMMESSI.has(gruppo.stato)) {
    throw new Error('AR_GROUP_NOT_ACCEPTING');
  }

  if (new Date(gruppo.expires_at) <= new Date()) {
    throw new Error('AR_GROUP_EXPIRED');
  }

  const pendingResult = await client.query(
    `
    SELECT
      id,
      veicolo_id,
      ar_group_id,
      ar_tratta,
      ar_vincolata,
      stato,
      expires_at
    FROM pending
    WHERE id = $1
    FOR UPDATE
    `,
    [pendingId]
  );

  const pending = pendingResult.rows[0];

  if (!pending) {
    throw new Error('AR_PENDING_NOT_FOUND');
  }

  if (
    pending.ar_vincolata !== true ||
    pending.ar_group_id !== arGroupId ||
    Number(pending.veicolo_id) !== Number(veicoloId) ||
    !['andata', 'ritorno'].includes(pending.ar_tratta)
  ) {
    throw new Error('AR_PENDING_GROUP_MISMATCH');
  }

  if (pending.stato !== 'pending') {
    throw new Error('AR_PENDING_NOT_AVAILABLE');
  }

  if (new Date(pending.expires_at) <= new Date()) {
    throw new Error('AR_PENDING_EXPIRED');
  }

  const expiresAt = new Date(
    Math.min(
      new Date(gruppo.expires_at).getTime(),
      new Date(pending.expires_at).getTime()
    )
  );

  const result = await client.query(
    `
    INSERT INTO ar_accettazioni (
      ar_group_id,
      pending_id,
      veicolo_id,
      stato,
      expires_at
    )
    VALUES ($1, $2, $3, 'provvisoria', $4)
    ON CONFLICT (pending_id)
    DO NOTHING
    RETURNING *
    `,
    [
      arGroupId,
      pendingId,
      veicoloId,
      expiresAt
    ]
  );

  if (result.rows.length === 1) {
    return {
      creata: true,
      accettazione: result.rows[0]
    };
  }

  const existing = await client.query(
    `
    SELECT *
    FROM ar_accettazioni
    WHERE pending_id = $1
    `,
    [pendingId]
  );

  const accettazione = existing.rows[0];

  if (
    accettazione?.stato === 'provvisoria' &&
    accettazione.ar_group_id === arGroupId &&
    Number(accettazione.veicolo_id) === Number(veicoloId) &&
    new Date(accettazione.expires_at) > new Date()
  ) {
    return {
      creata: false,
      accettazione
    };
  }

  throw new Error('AR_ACCEPTANCE_ALREADY_EXISTS');
}


/**
 * TURENTU — Verifica coppia A/R
 *
 * Richiede un client PostgreSQL.
 * Non modifica il database.
 *
 * Controlla:
 * - gruppo esistente e non scaduto
 * - esattamente due pending vincolati
 * - una andata e un ritorno
 * - accettazioni provvisorie valide
 * - coerenza gruppo/pending/veicolo
 *
 * NON certifica la disponibilità operativa dei veicoli.
 */

export async function verificaCoppiaAR(client, arGroupId) {
  if (typeof arGroupId !== 'string' || !arGroupId.trim()) {
    throw new Error('AR_GROUP_ID_INVALID');
  }

  const gruppoResult = await client.query(
    `
    SELECT
      id,
      stato,
      expires_at,
      expires_at > NOW() AS non_scaduto
    FROM ar_gruppi
    WHERE id = $1
    `,
    [arGroupId]
  );

  const gruppo = gruppoResult.rows[0];

  if (!gruppo) {
    throw new Error('AR_GROUP_NOT_FOUND');
  }

  const { rows } = await client.query(
    `
    SELECT
      p.id AS pending_id,
      p.ar_tratta,
      p.ar_vincolata,
      p.ar_group_id,
      p.veicolo_id,
      p.stato AS pending_stato,
      p.expires_at AS pending_expires_at,
      p.expires_at > NOW() AS pending_valido,

      aa.id AS accettazione_id,
      aa.stato AS accettazione_stato,
      aa.veicolo_id AS accettazione_veicolo_id,
      aa.ar_group_id AS accettazione_gruppo_id,
      aa.expires_at AS accettazione_expires_at,
      aa.expires_at > NOW() AS accettazione_valida

    FROM pending p

    LEFT JOIN ar_accettazioni aa
      ON aa.pending_id = p.id

    WHERE p.ar_group_id = $1

    ORDER BY p.id
    `,
    [arGroupId]
  );

  const base = {
    completa: false,
    gruppoId: arGroupId,
    statoGruppo: gruppo.stato,
    andata: null,
    ritorno: null,
    motivo: null
  };

  if (
    !gruppo.non_scaduto ||
    !['autorizzato', 'in_attesa', 'pronto'].includes(gruppo.stato)
  ) {
    return {
      ...base,
      motivo: 'AR_GROUP_NOT_ACTIVE'
    };
  }

  if (rows.length !== 2) {
    return {
      ...base,
      motivo: 'AR_PENDING_COUNT_INVALID'
    };
  }

  const andate = rows.filter(
    r => r.ar_tratta === 'andata'
  );

  const ritorni = rows.filter(
    r => r.ar_tratta === 'ritorno'
  );

  if (andate.length !== 1 || ritorni.length !== 1) {
    return {
      ...base,
      motivo: 'AR_LEGS_INVALID'
    };
  }

  const andata = andate[0];
  const ritorno = ritorni[0];

  const valida = r =>
    r.ar_vincolata === true &&
    r.ar_group_id === arGroupId &&
    r.pending_stato === 'pending' &&
    r.pending_valido === true &&
    r.accettazione_id != null &&
    r.accettazione_stato === 'provvisoria' &&
    r.accettazione_valida === true &&
    r.accettazione_gruppo_id === arGroupId &&
    Number(r.accettazione_veicolo_id) ===
      Number(r.veicolo_id);

  if (!valida(andata) || !valida(ritorno)) {
    return {
      ...base,
      andata,
      ritorno,
      motivo: 'AR_ACCEPTANCES_INCOMPLETE'
    };
  }

  return {
    completa: true,
    gruppoId: arGroupId,
    statoGruppo: gruppo.stato,
    andata,
    ritorno,
    motivo: null
  };
}

/**
 * TURENTU — Transizione A/R a pronto
 *
 * ATTENZIONE:
 * Funzione interna del coordinatore.
 *
 * Il chiamante deve:
 * - avere una transazione PostgreSQL aperta;
 * - avere acquisito i blocchi dei veicoli interessati;
 * - avere verificato tutti gli impegni operativi;
 * - non avere ancora eseguito COMMIT.
 *
 * Non conferma prenotazioni o pagamenti.
 */

export async function portaGruppoARPronto(
  client,
  arGroupId,
  { disponibilitaVeicoliVerificata = false } = {}
) {
  // Impedisce l'utilizzo accidentale senza verifica.
  if (disponibilitaVeicoliVerificata !== true) {
    throw new Error('AR_VEHICLE_VERIFICATION_REQUIRED');
  }

  const gruppoResult = await client.query(
    `
    SELECT id, stato, expires_at
    FROM ar_gruppi
    WHERE id = $1
    FOR UPDATE
    `,
    [arGroupId]
  );

  const gruppo = gruppoResult.rows[0];

  if (!gruppo) {
    throw new Error('AR_GROUP_NOT_FOUND');
  }

  if (!['in_attesa', 'pronto'].includes(gruppo.stato)) {
    throw new Error('AR_GROUP_INVALID_TRANSITION');
  }

  if (new Date(gruppo.expires_at) <= new Date()) {
    throw new Error('AR_GROUP_EXPIRED');
  }

  const coppia = await verificaCoppiaAR(client, arGroupId);

  if (!coppia.completa) {
    throw new Error(
      `AR_PAIR_NOT_READY:${coppia.motivo}`
    );
  }

  if (gruppo.stato === 'pronto') {
    return {
      aggiornato: false,
      stato: 'pronto',
      coppia
    };
  }

  const aggiornamento = await client.query(
    `
    UPDATE ar_gruppi
    SET
      stato = 'pronto',
      updated_at = NOW()
    WHERE id = $1
      AND stato = 'in_attesa'
      AND expires_at > NOW()
    RETURNING id, stato
    `,
    [arGroupId]
  );

  if (aggiornamento.rowCount !== 1) {
    throw new Error('AR_GROUP_TRANSITION_FAILED');
  }

  return {
    aggiornato: true,
    stato: 'pronto',
    coppia
  };
}
