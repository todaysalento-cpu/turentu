import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';

const router = Router();
let attempted = false;

router.post('/', async (req, res) => {
  if (process.env.GMAIL_TEST_ENABLED !== 'true') {
    return res.sendStatus(404);
  }

  const secret = process.env.GMAIL_TEST_SECRET;
  const received = req.get('x-gmail-test-secret') || '';
  if (!secret || !received) return res.sendStatus(403);

  const a = Buffer.from(secret);
  const b = Buffer.from(received);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.sendStatus(403);
  }

  if (attempted) {
    return res.status(409).json({ error: 'Test gia eseguito in questo processo' });
  }
  attempted = true;

  const names = [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REFRESH_TOKEN',
    'GMAIL_SENDER',
    'GMAIL_TEST_TO'
  ];

  if (names.some(name => !process.env[name])) {
    return res.status(503).json({ error: 'Configurazione Gmail incompleta' });
  }

  try {
    const auth = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

    const gmail = google.gmail({ version: 'v1', auth });
    const rawMessage = [
      `From: ${process.env.GMAIL_SENDER}`,
      `To: ${process.env.GMAIL_TEST_TO}`,
      'Subject: Test Gmail API Turentu',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Test invio email Turentu riuscito.'
    ].join('\r\n');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(rawMessage).toString('base64url')
      }
    });

    console.log('[GMAIL TEST] Invio riuscito, ID:', result.data.id);
    return res.json({ ok: true });
  } catch (error) {
    // Diagnostica limitata ai soli codici di errore: non esporre token,
    // intestazioni HTTP, credenziali o oggetti di errore completi.
    const googleError = error.response?.data?.error;
    const code = typeof googleError === 'string'
      ? googleError
      : googleError?.code;
    const reason = error.response?.data?.error_description;

    console.error('[GMAIL TEST] Diagnostica:', {
      status: error.response?.status ?? null,
      code: code ?? error.code ?? null,
      reason: typeof reason === 'string' ? reason.slice(0, 180) : null
    });

    return res.status(502).json({
      ok: false,
      error: 'Invio fallito; controllare i log Render'
    });
  }
});

export default router;
