
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const WIDTH = 1200;
const HEIGHT = 675;

const escapeXml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

function getMatchTeams(title) {
  const parts = String(title || '').split(/\s+-\s+/);
  return {
    home: parts[0]?.trim() || 'SQUADRA CASA',
    away: parts.slice(1).join(' - ').trim() || 'SQUADRA OSPITE'
  };
}

function fitText(value, max = 24) {
  const text = String(value || '').toUpperCase();
  return text.length > max
    ? `${text.slice(0, max - 1)}…`
    : text;
}

async function getBackground(homeTeam) {
  const filename = /lecce/i.test(homeTeam)
    ? 'via-del-mare.jpg'
    : 'trasferta.jpg';

  const filenamePath = path.resolve(
    'assets',
    'eventi',
    filename
  );

  try {
    await fs.access(filenamePath);
    return filenamePath;
  } catch {
    return null;
  }
}

export async function generaCopertinaPartita(evento) {
  const { home, away } = getMatchTeams(evento.titolo);

  const date = new Date(evento.data_inizio);

  const data = Number.isNaN(date.getTime())
    ? 'DATA DA CONFERMARE'
    : new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        day: '2-digit',
        month: 'long',
        year: 'numeric'
      }).format(date).toUpperCase();

  const ora = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);

  const competition =
    /coppa italia/i.test(evento.descrizione || '')
      ? 'COPPA ITALIA'
      : 'SERIE A';

  const background = await getBackground(home);

  const backgroundLayer = background
    ? await sharp(background)
        .resize(WIDTH, HEIGHT, { fit: 'cover' })
        .png()
        .toBuffer()
    : {
        create: {
          width: WIDTH,
          height: HEIGHT,
          channels: 4,
          background: '#201d26'
        }
      };

  const svg = `
  <svg width="${WIDTH}" height="${HEIGHT}"
       xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shade" x1="0" y1="0"
                      x2="0" y2="1">
        <stop offset="0%" stop-color="#000"
              stop-opacity=".50"/>
        <stop offset="100%" stop-color="#000"
              stop-opacity=".88"/>
      </linearGradient>
    </defs>

    <rect width="1200" height="675"
          fill="url(#shade)"/>

    <text x="65" y="75"
          font-family="Arial,sans-serif"
          font-size="36" font-weight="bold"
          fill="#ff3036">TURENTU</text>

    <text x="1130" y="75"
          text-anchor="end"
          font-family="Arial,sans-serif"
          font-size="25" font-weight="bold"
          fill="white">${escapeXml(competition)}</text>

    <text x="600" y="225"
          text-anchor="middle"
          font-family="Arial,sans-serif"
          font-size="65" font-weight="bold"
          fill="white">${escapeXml(fitText(home))}</text>

    <text x="600" y="305"
          text-anchor="middle"
          font-family="Arial,sans-serif"
          font-size="46" font-weight="bold"
          fill="#ff3036">VS</text>

    <text x="600" y="390"
          text-anchor="middle"
          font-family="Arial,sans-serif"
          font-size="65" font-weight="bold"
          fill="white">${escapeXml(fitText(away))}</text>

    <text x="600" y="465"
          text-anchor="middle"
          font-family="Arial,sans-serif"
          font-size="26"
          fill="white">${escapeXml(data)} · ${escapeXml(ora)}</text>

    <rect x="0" y="565"
          width="1200" height="110"
          fill="#ff3036"/>

    <text x="600" y="632"
          text-anchor="middle"
          font-family="Arial,sans-serif"
          font-size="33" font-weight="bold"
          fill="white">RAGGIUNGI LO STADIO CON TURENTU</text>
  </svg>`;

  return sharp(backgroundLayer)
    .composite([{
      input: Buffer.from(svg),
      top: 0,
      left: 0
    }])
    .png()
    .toBuffer();
}
