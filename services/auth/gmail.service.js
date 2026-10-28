import { google } from 'googleapis';

export async function sendPasswordResetCode(to, code) {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER } = process.env;
  if (![GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER].every(Boolean)) {
    throw new Error('Configurazione Gmail incompleta');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  const subject = 'Turentu - Codice recupero password';
  const message = `Il tuo codice Turentu per reimpostare la password e': ${code}\n\nIl codice scade tra 10 minuti. Se non hai richiesto il recupero, ignora questa email.\n`;
  // Encode display values safely; recipient comes from validated email in the router.
  const raw = [
    `From: ${GMAIL_SENDER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '', message
  ].join('\r\n');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') }
  });
}
