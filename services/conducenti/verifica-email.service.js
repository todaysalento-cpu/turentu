// TURENTU - verifica email per account autenticati.
// Dipendenze: pg Pool, nodemailer (gia' presente nel progetto).
import { randomBytes, createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (value) => String(value ?? '').trim().toLowerCase();
const id = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw fail('Utente non valido', 401);
  return n;
};
const tokenValido = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function smtpTransport() {
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) {
    if (!process.env[key]) throw fail('Configurazione SMTP incompleta', 503);
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function urlVerifica(token) {
  const base = process.env.TURENTU_EMAIL_VERIFY_BASE_URL;
  if (!base || !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^?#]*)?$/i.test(base)) {
    throw fail('TURENTU_EMAIL_VERIFY_BASE_URL non configurato (HTTPS richiesto)', 503);
  }
  return `${base.replace(/\/$/, '')}/verifica-email?token=${token}`;
}

export async function statoVerificaEmail(pool, utenteId) {
  const { rows } = await pool.query(
    'SELECT email, email_verificata_il FROM public.utente WHERE id=$1', [id(utenteId)]
  );
  if (!rows.length) throw fail('Utente non trovato', 404);
  return { email: rows[0].email, verificata: !!rows[0].email_verificata_il,
    email_verificata_il: rows[0].email_verificata_il };
}

export async function richiediVerificaEmail(pool, utenteId) {
  const uid = id(utenteId);
  const transport = smtpTransport();
  const token = randomBytes(32).toString('hex');
  const link = urlVerifica(token);
  const client = await pool.connect();
  let verificaId;
  let email;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT email, email_verificata_il FROM public.utente WHERE id=$1 FOR UPDATE', [uid]
    );
    if (!rows.length) throw fail('Utente non trovato', 404);
    if (rows[0].email_verificata_il) throw fail('Email gia verificata', 409);
    email = normalize(rows[0].email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Email account non valida');
    await client.query(`UPDATE public.verifiche_email_utente SET revocato_il=NOW()
      WHERE utente_id=$1 AND consumato_il IS NULL AND revocato_il IS NULL`, [uid]);
    const result = await client.query(`INSERT INTO public.verifiche_email_utente
      (utente_id,email_destinatario,token_hash,scade_il)
      VALUES ($1,$2,$3,NOW()+INTERVAL '30 minutes') RETURNING id`,
      [uid, email, hash(token)]);
    verificaId = result.rows[0].id;
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* log nel chiamante */ }
    throw error;
  } finally {
    client.release();
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Turentu - verifica il tuo indirizzo email',
      text: `Per verificare il tuo indirizzo email Turentu apri questo link entro 30 minuti:\n${link}\n\nSe non hai richiesto questa verifica, ignora il messaggio.`,
    });
  } catch (error) {
    // Un invio fallito non deve lasciare un link utilizzabile.
    await pool.query(`UPDATE public.verifiche_email_utente SET revocato_il=NOW()
      WHERE id=$1 AND consumato_il IS NULL AND revocato_il IS NULL`, [verificaId]);
    throw fail('Impossibile inviare la verifica email. Riprova piu tardi.', 503);
  }
  return { inviata: true, scadenza_minuti: 30 };
}

export async function confermaVerificaEmail(pool, { utenteId, token }) {
  const uid = id(utenteId);
  if (!tokenValido(token)) throw fail('Token non valido');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: utenti } = await client.query(
      'SELECT email FROM public.utente WHERE id=$1 FOR UPDATE', [uid]
    );
    if (!utenti.length) throw fail('Utente non trovato', 404);
    const { rows } = await client.query(`SELECT id,email_destinatario FROM public.verifiche_email_utente
      WHERE utente_id=$1 AND token_hash=$2 AND consumato_il IS NULL AND revocato_il IS NULL
      AND scade_il>NOW() FOR UPDATE`, [uid, hash(token)]);
    if (!rows.length) throw fail('Verifica non valida, scaduta o gia utilizzata', 409);
    if (normalize(utenti[0].email) !== normalize(rows[0].email_destinatario)) {
      throw fail('Indirizzo email modificato: richiedere una nuova verifica', 409);
    }
    await client.query('UPDATE public.utente SET email_verificata_il=NOW() WHERE id=$1', [uid]);
    await client.query('UPDATE public.verifiche_email_utente SET consumato_il=NOW() WHERE id=$1', [rows[0].id]);
    await client.query(`UPDATE public.verifiche_email_utente SET revocato_il=NOW()
      WHERE utente_id=$1 AND id<>$2 AND consumato_il IS NULL AND revocato_il IS NULL`, [uid, rows[0].id]);
    await client.query('COMMIT');
    return { verificata: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* log nel chiamante */ }
    throw error;
  } finally {
    client.release();
  }
}
