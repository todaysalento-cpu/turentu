
import { google } from 'googleapis';

const required = [
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_SENDER',
  'GMAIL_TEST_TO'
];

const missing = required.filter(key => !process.env[key]);

if (missing.length) {
  console.error('Variabili mancanti:', missing.join(', '));
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);

oauth2.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({
  version: 'v1',
  auth: oauth2
});

const message = [
  `From: ${process.env.GMAIL_SENDER}`,
  `To: ${process.env.GMAIL_TEST_TO}`,
  'Subject: Test Gmail API Turentu',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Test invio email Turentu riuscito.'
].join('\r\n');

const raw = Buffer.from(message)
  .toString('base64url');

try {
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  console.log('EMAIL INVIATA');
  console.log('Message ID:', response.data.id);
} catch (error) {
  console.error(
    'ERRORE GMAIL:',
    error.response?.data?.error?.message || error.message
  );
  process.exitCode = 1;
}
