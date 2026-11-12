import { randomUUID } from 'node:crypto';

// Le relazioni commerciali mantengono gli ID. I dati identificativi vengono rimossi.
export async function anonymizeAccount(db, id) {
  const { rows: assets } = await db.query(`
    SELECT url FROM documenti_autista WHERE autista_id = $1
    UNION SELECT foto_profilo FROM autista_profilo WHERE utente_id = $1
    UNION SELECT value #>> '{}' FROM autista_profilo,
      LATERAL jsonb_path_query(coalesce(documenti, '{}'::jsonb), '$.** ? (@.type() == "string")') AS value
      WHERE utente_id = $1
    UNION SELECT image_url FROM veicolo WHERE driver_id = $1
    UNION SELECT audio_url FROM messaggi WHERE sender_id = $1
    UNION SELECT media_url FROM messaggi WHERE sender_id = $1
  `, [id]);
  for (const { url } of assets) {
    if (typeof url !== 'string' || !url.trim() || !/^https?:\/\//i.test(url)) continue;
    await db.query(`
      INSERT INTO admin_rimozioni_file_utenti (utente_id, url)
      VALUES ($1, $2) ON CONFLICT (utente_id, url) DO NOTHING
    `, [id, url]);
  }

  const { rows: vehicles } = await db.query('SELECT id FROM veicolo WHERE driver_id = $1', [id]);
  const { rows: availability } = await db.query(`
    DELETE FROM disponibilita_veicolo d USING veicolo v
    WHERE d.veicolo_id = v.id AND v.driver_id = $1 RETURNING d.id
  `, [id]);
  for (const [type, rows] of [['veicolo', vehicles], ['disponibilita', availability]]) {
    for (const row of rows) {
      await db.query(`
        INSERT INTO admin_rimozioni_file_utenti (utente_id, tipo, risorsa_id)
        VALUES ($1, $2, $3) ON CONFLICT (utente_id, tipo, risorsa_id) DO NOTHING
      `, [id, type, row.id]);
    }
  }

  const updates = [
    "DELETE FROM utente_push_tokens WHERE user_id = $1",
    "DELETE FROM password_reset_codes WHERE user_id = $1",
    "DELETE FROM verifiche_email_utente WHERE utente_id = $1",
    "DELETE FROM notifications WHERE user_id = $1",
    "DELETE FROM documenti_autista WHERE autista_id = $1",
    `UPDATE autista_profilo SET nome = 'Utente', cognome = 'eliminato', telefono = '',
      iban = '', foto_profilo = NULL, documenti = '{}'::jsonb, certificato_ncc = false,
      nome_titolare_conto = NULL, nome_banca = NULL, updated_at = now() WHERE utente_id = $1`,
    `UPDATE anagrafica_conducenti SET nome = 'Utente', cognome = 'eliminato', email = NULL,
      telefono = NULL, data_nascita = NULL, categoria_patente = NULL, scadenza_patente = NULL,
      numero_patente = NULL, stato = 'disattivato', aggiornato_il = now()
      WHERE utente_id = $1 OR (operatore_id = $1 AND utente_id IS NULL)`,
    `UPDATE inviti_anagrafica_conducenti SET email_destinatario = 'eliminato@account.invalid',
      revocato_il = now()
      WHERE operatore_id = $1 OR anagrafica_id IN (
        SELECT id FROM anagrafica_conducenti WHERE utente_id = $1
      )`,
    `UPDATE conducenti_operatori SET stato = 'sospeso', assegnabile_automaticamente = false,
      sempre_disponibile = false, aggiornato_il = now() WHERE conducente_id = $1 OR operatore_id = $1`,
    `UPDATE messaggi SET testo = '[contenuto rimosso]', tipo_messaggio = 'text',
      audio_url = NULL, media_url = NULL, lat = NULL, lng = NULL, duration = 0 WHERE sender_id = $1`,
    `UPDATE chat_threads SET last_message = NULL, last_message_preview = NULL
      WHERE cliente_id = $1 OR driver_id = $1
        OR last_message_id IN (SELECT id FROM messaggi WHERE sender_id = $1)`,
    "UPDATE recensioni SET commento = NULL WHERE utente_id = $1",
    "UPDATE flow_events SET payload = '{}'::jsonb WHERE user_id = $1::integer::text",
    `UPDATE prenotazioni SET lat_salita = NULL, lon_salita = NULL,
      lat_discesa = NULL, lon_discesa = NULL WHERE cliente_id = $1`,
    `UPDATE pending SET origine = NULL, destinazione = NULL,
      origine_address = NULL, destinazione_address = NULL WHERE cliente_id = $1`,
    `UPDATE richieste_pop_bus SET origine = NULL, destinazione = NULL,
      origine_address = NULL, destinazione_address = NULL WHERE cliente_id = $1`,
    `UPDATE veicolo SET targa = NULL, numero_licenza_ncc = NULL,
      comune_licenza = NULL, image_url = NULL, coord = NULL, localita = NULL,
      stato = 'eliminato', stato_verifica = NULL WHERE driver_id = $1`,
  ];
  for (const statement of updates) await db.query(statement, [id]);
  await db.query(`
    UPDATE utente SET nome = 'Utente eliminato', email = $2, password = 'ACCOUNT_ELIMINATO',
      phone = NULL, apple_id = NULL, reset_token = NULL, reset_expires = NULL,
      otp_code = NULL, otp_expires = NULL, email_verificata_il = NULL,
      modalita_operativa = NULL, eliminato_il = now()
    WHERE id = $1
  `, [id, 'eliminato-' + id + '-' + randomUUID() + '@account.invalid']);
  return { vehicles, availability };
}
