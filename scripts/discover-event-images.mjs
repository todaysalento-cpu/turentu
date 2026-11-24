import 'dotenv/config';
import fs from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { pool } from '../db/db.js';

import {
  extractEventImages
} from '../services/eventi/image-discovery/puglia-culture.js';

import {
  normalizeEventTitle
} from '../services/eventi/event-image-discovery.service.js';

const args = process.argv.slice(2);

const arg = name =>
  args.find(a => a.startsWith(`--${name}=`))
    ?.split('=').slice(1).join('=');

const eventId = Number(arg('event-id'));
const file = arg('file');
const pageUrl = arg('url');
const apply = args.includes('--apply');

try {
  if (!Number.isInteger(eventId) || eventId <= 0 || !file || !pageUrl) {
    throw new Error('Parametri obbligatori mancanti');
  }

  const url = new URL(pageUrl);

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.pugliaculture.it' ||
    !url.pathname.startsWith('/evento/') ||
    url.username || url.password || url.port
  ) {
    throw new Error('Pagina evento non supportata');
  }

  const { rows: events } = await pool.query(
    'SELECT id, titolo FROM public.eventi WHERE id = $1',
    [eventId]
  );

  if (!events.length) {
    throw new Error('Evento non trovato');
  }

  const event = events[0];

  let html = await fs.readFile(file, 'utf8');

  const $ = cheerio.load(html);

  if ($('td.line-content').length) {
    html = $('td.line-content')
      .map((i, e) => $(e).text())
      .get()
      .join('\n');
  }

  const result = extractEventImages(html, pageUrl);

  if (
    normalizeEventTitle(result.titolo) !==
    normalizeEventTitle(event.titolo)
  ) {
    throw new Error('Titolo evento non corrispondente');
  }

  const { rows: sources } = await pool.query(
    `SELECT id FROM public.event_image_sources
     WHERE dominio = $1`,
    [url.hostname]
  );

  if (!sources.length) {
    throw new Error('Fonte non registrata');
  }

  console.log('Evento:', event.id, event.titolo);
  console.log('Modalita:', apply ? 'APPLY' : 'DRY-RUN');
  console.table(result.immagini);

  let inserted = 0;

  if (apply) {
    for (const image of result.immagini) {
      const r = await pool.query(`
        INSERT INTO public.event_image_candidates (
          evento_id,
          source_id,
          titolo_immagine,
          pagina_url,
          immagine_originale_url,
          confidenza,
          stato,
          diritti_verificati,
          note
        )
        VALUES ($1,$2,$3,$4,$5,95,'pending',false,$6)
        ON CONFLICT (
          evento_id,
          immagine_originale_url
        ) DO NOTHING
      `, [
        event.id,
        sources[0].id,
        result.titolo,
        pageUrl,
        image.immagineUrl,
        `Estrazione da HTML locale: ${image.metodo}`
      ]);

      inserted += r.rowCount;
    }
  }

  console.log('Candidate trovate:', result.immagini.length);
  console.log('Nuove candidate inserite:', inserted);

} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}