import { google } from 'googleapis';

export function isGmailConfigured() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER } = process.env;
  return [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER].every(Boolean);
}

export async function sendTurentuEmail(to, subject, message) {
  if (!isGmailConfigured()) throw new Error('Configurazione Gmail incompleta');

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER } = process.env;
  if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(to) || /[\r\n]/.test(GMAIL_SENDER + subject)) {
    throw new Error('Destinatario o intestazioni email non validi');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  const subjectHeader = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
  const raw = [
    `From: ${GMAIL_SENDER}`,
    `To: ${to}`,
    `Subject: ${subjectHeader}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '', message,
  ].join('\r\n');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') },
  }, { timeout: 15000 });
}

export async function sendPasswordResetCode(to, code) {
  const subject = 'Turentu - Codice recupero password';
  const message = `Il tuo codice Turentu per reimpostare la password e': ${code}\n\nIl codice scade tra 10 minuti. Se non hai richiesto il recupero, ignora questa email.\n`;
  await sendTurentuEmail(to, subject, message);
}
