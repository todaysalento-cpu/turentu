import 'dotenv/config';
import fs from 'node:fs/promises';
import { pool } from '../db/db.js';

import {
  extractEventLinks
} from '../services/eventi/image-discovery/puglia-culture.js';

import {
  listMissingEventImages,
  normalizeEventTitle
} from '../services/eventi/event-image-discovery.service.js';

const args = process.argv.slice(2);

const arg = name =>
  args.find(a => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const file = arg('file');
const pageUrl = arg('url');

try {
  if (!file || !pageUrl) {
    throw new Error('Parametri --file e --url obbligatori');
  }

  const html = await fs.readFile(file, 'utf8');

  const links = extractEventLinks(html, pageUrl);

  const events = (await listMissingEventImages())
    .filter(e =>
      e.image_source_domain === 'www.pugliaculture.it' &&
      e.source_url === pageUrl
    );

  const matches = [];
  const missing = [];
  const ambiguous = [];

  for (const event of events) {
    const candidates = links.filter(link =>
      normalizeEventTitle(link.titolo) ===
      normalizeEventTitle(event.titolo)
    );

    if (candidates.length === 0) {
      missing.push({
        id: event.id,
        titolo: event.titolo
      });

      continue;
    }

    if (candidates.length > 1) {
      ambiguous.push({
        id: event.id,
        titolo: event.titolo,
        candidati: candidates.length
      });

      continue;
    }

    matches.push({
      id: event.id,
      titolo: event.titolo,
      citta: event.citta,
      paginaUrl: candidates[0].paginaUrl
    });
  }

  console.log('\nCORRISPONDENZE');
  console.table(matches);

  console.log('\nSENZA CORRISPONDENZA');
  console.table(missing);

  console.log('\nCORRISPONDENZE AMBIGUE');
  console.table(ambiguous);

  console.log('\nRIEPILOGO');
  console.log('Schede trovate:', links.length);
  console.log('Eventi da associare:', events.length);
  console.log('Associati:', matches.length);
  console.log('Non associati:', missing.length);
  console.log('Ambigui:', ambiguous.length);

  await fs.writeFile(
    'event-image-pages.json',
    JSON.stringify(matches, null, 2),
    'utf8'
  );

  console.log('Catalogo: event-image-pages.json');

} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}