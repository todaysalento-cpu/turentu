// TURENTU - Inviti anagrafica NCC.
// Invito monouso; accettazione autenticata con email verificata.
// La generazione restituisce un link: non invia automaticamente email/WhatsApp.
import { randomBytes, createHash } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw fail('ID non valido');
  return n;
};
const digest = (token) => createHash('sha256').update(token).digest('hex');
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeBase = (value) => {
  const s = String(value ?? '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^?#]*)?$/i.test(s)) {
    throw fail('TURENTU_INVITE_BASE_URL deve essere HTTPS');
  }
  return s.replace(/\/$/, '');
};
const rollback = async (client) => {
  try { await client.query('ROLLBACK'); }
  catch (error) { console.error('[inviti-anagrafica] rollback:', error); }
};

export async function preparaInvitoAnagrafica(pool, { operatoreId, anagraficaId, baseUrl }) {
  const op = id(operatoreId);
  const an = id(anagraficaId);
  const base = safeBase(baseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT id, email, nome, cognome, stato, utente_id
      FROM public.anagrafica_conducenti
      WHERE id = $1 AND operatore_id = $2 FOR UPDATE`, [an, op]);
    const a = rows[0];
    if (!a || !['bozza', 'invitato'].includes(a.stato) || a.utente_id !== null) {
      throw fail('Anagrafica non invitabile', 409);
    }
    const email = normalizeEmail(a.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Email valida obbligatoria');

    await client.query(`
      UPDATE public.inviti_anagrafica_conducenti SET revocato_il = NOW()
      WHERE anagrafica_id = $1 AND consumato_il IS NULL AND revocato_il IS NULL`, [an]);

    const token = randomBytes(32).toString('hex');
    const { rows: created } = await client.query(`
      INSERT INTO public.inviti_anagrafica_conducenti
        (anagrafica_id, operatore_id, token_hash, email_destinatario, scade_il)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '72 hours')
      RETURNING id, scade_il`, [an, op, digest(token), email]);
    await client.query(`
      UPDATE public.anagrafica_conducenti
      SET stato = 'invitato', aggiornato_il = NOW()
      WHERE id = $1`, [an]);
    await client.query('COMMIT');

    const link = `${base}/invito-conducente?token=${token}`;
    return {
      invito_id: created[0].id,
      scade_il: created[0].scade_il,
      email,
      nome: a.nome,
      cognome: a.cognome,
      link,
      messaggio: `Ciao ${a.nome}, sei stato invitato a collegarti come conducente su Turentu. Accedi o registrati e apri questo link (valido 72 ore): ${link}`,
      avvertenza: 'Link riservato: condividerlo solo con il destinatario. Invio email/WhatsApp non automatico.'
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function accettaInvitoAnagrafica(pool, { utenteId, token }) {
  const uid = id(utenteId);
  if (!validToken(token)) throw fail('Token non valido');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializza tutte le accettazioni per questo account, anche da operatori diversi.
    await client.query('SELECT pg_advisory_xact_lock(731905, $1)', [uid]);

    // L'email viene letta dal database, non dal JWT o dal body della richiesta.
    const { rows: users } = await client.query(`
      SELECT id, email, tipo, email_verificata_il
      FROM public.utente WHERE id = $1 FOR UPDATE`, [uid]);
    const user = users[0];
    if (!user || !['cliente', 'autista'].includes(user.tipo)) {
      throw fail('Account conducente non abilitato: verificare il ruolo', 403);
    }
    if (!user.email_verificata_il) {
      throw fail('Verifica prima l’indirizzo email del tuo account Turentu', 403);
    }

    const { rows } = await client.query(`
      SELECT i.*, a.stato, a.utente_id, a.email AS email_anagrafica,
             a.operatore_id AS operatore_anagrafica
      FROM public.inviti_anagrafica_conducenti i
      JOIN public.anagrafica_conducenti a ON a.id = i.anagrafica_id
      WHERE i.token_hash = $1 FOR UPDATE OF i, a`, [digest(token)]);
    const inv = rows[0];
    if (!inv || inv.consumato_il || inv.revocato_il ||
        new Date(inv.scade_il).getTime() <= Date.now() ||
        inv.stato !== 'invitato' || inv.utente_id !== null) {
      throw fail('Invito non valido, scaduto o già utilizzato', 409);
    }
    if (Number(inv.operatore_id) !== Number(inv.operatore_anagrafica)) {
      throw fail('Invito non coerente con l’operatore', 409);
    }
    if (normalizeEmail(user.email) !== normalizeEmail(inv.email_destinatario) ||
        normalizeEmail(inv.email_anagrafica) !== normalizeEmail(inv.email_destinatario)) {
      throw fail('Accedi con l’account Turentu con email verificata corrispondente all’invito', 403);
    }
    if (uid === Number(inv.operatore_id)) throw fail('Il titolare non può accettare questo invito', 409);

    // Protegge dal collegamento di un account già presente in un'altra anagrafica.
    const { rows: linked } = await client.query(`
      SELECT id FROM public.anagrafica_conducenti
      WHERE utente_id = $1 AND id <> $2 LIMIT 1`, [uid, inv.anagrafica_id]);
    if (linked.length) throw fail('Account già collegato a un’altra anagrafica', 409);

    const { rows: other } = await client.query(`
      SELECT id FROM public.conducenti_operatori
      WHERE conducente_id = $1 AND operatore_id <> $2 AND stato = 'attivo' LIMIT 1`,
      [uid, inv.operatore_id]);
    if (other.length) throw fail('Conducente già attivo presso un altro operatore', 409);

    const { rows: existing } = await client.query(`
      SELECT id, stato FROM public.conducenti_operatori
      WHERE conducente_id = $1 AND operatore_id = $2 FOR UPDATE`,
      [uid, inv.operatore_id]);
    if (existing.length && !['rifiutato', 'invitato'].includes(existing[0].stato)) {
      throw fail('Rapporto operatore già esistente', 409);
    }
    if (existing.length) {
      await client.query(`
        UPDATE public.conducenti_operatori
        SET stato = 'attivo', assegnabile_automaticamente = false, aggiornato_il = NOW()
        WHERE id = $1`, [existing[0].id]);
    } else {
      await client.query(`
        INSERT INTO public.conducenti_operatori
          (operatore_id, conducente_id, stato, assegnabile_automaticamente, sempre_disponibile)
        VALUES ($1, $2, 'attivo', false, false)`, [inv.operatore_id, uid]);
    }
    await client.query(`
      UPDATE public.anagrafica_conducenti
      SET utente_id = $1, stato = 'collegato', aggiornato_il = NOW()
      WHERE id = $2`, [uid, inv.anagrafica_id]);
    await client.query(`
      UPDATE public.inviti_anagrafica_conducenti SET consumato_il = NOW() WHERE id = $1`, [inv.id]);
    await client.query('COMMIT');
    return { anagrafica_id: inv.anagrafica_id, operatore_id: inv.operatore_id, stato: 'collegato' };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
