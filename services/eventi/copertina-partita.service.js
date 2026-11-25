import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const W = 1200;
const H = 675;

const BACKGROUNDS = path.resolve('assets', 'eventi');

const LECCE_COVERS = {
  casa: 'lecce-casa.png',
  trasferta: 'lecce-trasferta.png',
};

const xml = value =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const safeName = value =>
  String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);

const short = (value, max = 23) => {
  const s = String(value || '').toLocaleUpperCase('it-IT');
  return s.length > max
    ? `${s.slice(0, max - 1)}…`
    : s;
};

const isLecce = value =>
  /^(?:u\.?\s*s\.?\s+)?lecce$/i.test(
    String(value || '').trim()
  );

// Nuove copertine Lecce casa e trasferta
async function lecceCoverFor(home, away) {
  const filename = isLecce(home)
    ? LECCE_COVERS.casa
    : isLecce(away)
      ? LECCE_COVERS.trasferta
      : null;

  if (!filename) return null;

  const filepath = path.join(BACKGROUNDS, filename);

  try {
    await fs.access(filepath);

    return await sharp(filepath)
      .rotate()
      .resize({
        width: W,
        height: H,
        fit: 'cover',
      })
      .png()
      .toBuffer();

  } catch (error) {
    console.warn(
      '[COPERTINA] Copertina Lecce non disponibile:',
      filename,
      error.message
    );

    return null;
  }
}

// Generatore precedente utilizzato come fallback
async function backgroundFor(home) {
  const filenames = [
    `${safeName(home)}.jpg`,
    isLecce(home)
      ? 'via-del-mare.jpg'
      : 'trasferta.jpg',
  ];

  for (const filename of filenames) {
    const filepath = path.join(BACKGROUNDS, filename);

    try {
      await fs.access(filepath);

      return await sharp(filepath)
        .resize(W, H, { fit: 'cover' })
        .png()
        .toBuffer();

    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(
          '[COPERTINA] Sfondo non utilizzabile:',
          filename,
          error.message
        );
      }
    }
  }

  return await sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: isLecce(home)
        ? '#5a3026'
        : '#202b40',
    },
  })
    .png()
    .toBuffer();
}

export async function generaCopertinaPartita(evento) {
  const [home = 'CASA', ...rest] = String(
    evento.titolo || ''
  ).split(/\s+-\s+/);

  const away = rest.join(' - ') || 'OSPITI';

  // Priorità alle nuove copertine Lecce.
  // Nessuna scritta o sovrapposizione grafica.
  const lecceCover = await lecceCoverFor(home, away);

  if (lecceCover) {
    return lecceCover;
  }

  // Fallback al generatore originale.
  const dt = new Date(evento.data_inizio);
  const validDate = !Number.isNaN(dt.getTime());

  const date = validDate
    ? new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })
        .format(dt)
        .toLocaleUpperCase('it-IT')
    : 'DATA DA CONFERMARE';

  const hour = validDate
    ? new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        hour: '2-digit',
        minute: '2-digit',
      }).format(dt)
    : '';

  const competition = /coppa italia/i.test(
    evento.descrizione || ''
  )
    ? 'COPPA ITALIA'
    : 'SERIE A';

  const background = await backgroundFor(home);

  const overlay = `
  <svg xmlns="http://www.w3.org/2000/svg"
       width="${W}" height="${H}">

    <defs>
      <linearGradient id="shade"
                      x1="0" y1="0"
                      x2="0" y2="1">
        <stop stop-color="#05070b"
              stop-opacity=".48"/>
        <stop offset="1"
              stop-color="#05070b"
              stop-opacity=".92"/>
      </linearGradient>
    </defs>

    <rect width="1200" height="675"
          fill="url(#shade)"/>

    <text x="65" y="78"
          font-family="Arial, sans-serif"
          font-size="42"
          font-weight="bold"
          fill="#ff3036">TURENTU</text>

    <text x="1135" y="75"
          text-anchor="end"
          font-family="Arial, sans-serif"
          font-size="28"
          font-weight="bold"
          fill="white">${xml(competition)}</text>

    <text x="600" y="230"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="68"
          font-weight="bold"
          fill="white">${xml(short(home))}</text>

    <text x="600" y="315"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="48"
          font-weight="bold"
          fill="#ff3036">VS</text>

    <text x="600" y="400"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="68"
          font-weight="bold"
          fill="white">${xml(short(away))}</text>

    <text x="600" y="477"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="30"
          fill="white">${xml(date)}${
            hour ? ` · ${xml(hour)}` : ''
          }</text>

    <rect x="0" y="565"
          width="1200" height="110"
          fill="#ff3036"/>

    <text x="600" y="632"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="33"
          font-weight="bold"
          fill="white">RAGGIUNGI LO STADIO CON TURENTU</text>

  </svg>`;

  return sharp(background)
    .composite([
      {
        input: Buffer.from(overlay),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}