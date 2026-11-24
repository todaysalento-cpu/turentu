import 'dotenv/config';
import fs from 'node:fs/promises';
import https from 'node:https';
import { pool } from '../db/db.js';

import {
  extractEventImages
} from '../services/eventi/image-discovery/puglia-culture.js';

import {
  normalizeEventTitle
} from '../services/eventi/event-image-discovery.service.js';

const DOMAIN = 'www.pugliaculture.it';
const MAX_HTML = 2 * 1024 * 1024;
const TIMEOUT = 10000;
const DELAY = 2000;

const args = process.argv.slice(2);

const arg = name =>
  args.find(a => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const catalogFile =
  arg('catalog') || 'event-image-pages.json';

const localFile = arg('file');
const selectedId = arg('event-id')
  ? Number(arg('event-id'))
  : null;

const apply = args.includes('--apply');
const remote = args.includes('--remote');

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function validatePage(value) {
  const url = new URL(value);

  if (
    url.protocol !== 'https:' ||
    url.hostname !== DOMAIN ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith('/evento/')
  ) {
    throw new Error('URL evento non consentito');
  }

  return url;
}

function readRemoteHtml(value) {
  const url = validatePage(value);

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Turentu-EventImageDiscovery/1.0',
        'Accept': 'text/html',
        'Accept-Encoding': 'identity'
      }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const contentType =
        res.headers['content-type'] || '';

      if (!contentType.includes('text/html')) {
        res.resume();
        reject(new Error('Contenuto non HTML'));
        return;
      }

      const chunks = [];
      let size = 0;

      res.on('data', chunk => {
        size += chunk.length;

        if (size > MAX_HTML) {
          req.destroy(
            new Error('HTML troppo grande')
          );
          return;
        }

        chunks.push(chunk);
      });

      res.on('error', reject);

      res.on('end', () => {
        resolve(
          Buffer.concat(chunks).toString('utf8')
        );
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error('Timeout richiesta'));
    }, TIMEOUT);

    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

async function registerCandidate(
  event,
  source,
  image
) {
  if (!apply) return 0;

  const result = await pool.query(`
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
    VALUES (
      $1,$2,$3,$4,$5,95,'pending',false,$6
    )
    ON CONFLICT (
      evento_id,
      immagine_originale_url
    ) DO NOTHING
  `, [
    event.id,
    source.id,
    image.titolo,
    image.paginaUrl,
    image.immagineUrl,
    `Event Image Discovery: ${image.metodo}`
  ]);

  return result.rowCount;
}

const stats = {
  eventi: 0,
  elaborati: 0,
  candidate: 0,
  inserite: 0,
  giaPresenti: 0,
  senzaImmagine: 0,
  bloccati: 0,
  errori: 0
};

try {
  if (remote && localFile) {
    throw new Error(
      'Usare --remote oppure --file, non entrambi'
    );
  }

  if (localFile && !selectedId) {
    throw new Error(
      '--file richiede --event-id'
    );
  }

  if (
    selectedId !== null &&
    (!Number.isInteger(selectedId) || selectedId <= 0)
  ) {
    throw new Error('ID evento non valido');
  }

  let catalog = JSON.parse(
    await fs.readFile(catalogFile, 'utf8')
  );

  if (!Array.isArray(catalog)) {
    throw new Error('Catalogo non valido');
  }

  if (selectedId !== null) {
    catalog = catalog.filter(
      e => Number(e.id) === selectedId
    );
  }

  if (!catalog.length) {
    throw new Error('Nessun evento nel catalogo');
  }

  stats.eventi = catalog.length;

  const { rows: sources } = await pool.query(`
    SELECT *
    FROM public.event_image_sources
    WHERE dominio = $1
  `, [DOMAIN]);

  if (!sources.length) {
    throw new Error('Fonte non registrata');
  }

  const source = sources[0];

  console.log('Fonte:', source.nome);
  console.log(
    'Modalita:', apply ? 'APPLY' : 'DRY-RUN'
  );
  console.log(
    'Acquisizione:',
    remote ? 'REMOTA' : 'LOCALE'
  );

  if (remote && !source.ricerca_abilitata) {
    stats.bloccati = catalog.length;

    console.log(
      'FONTE NON AUTORIZZATA ALLA RICERCA'
    );

  } else if (!remote && !localFile) {
    stats.bloccati = catalog.length;

    console.log(
      'Specificare --file oppure --remote'
    );

  } else {
    for (const item of catalog) {
      try {
        validatePage(item.paginaUrl);

        const { rows } = await pool.query(`
          SELECT id, titolo, citta, data_inizio
          FROM public.eventi_senza_copertina
          WHERE id = $1
        `, [item.id]);

        if (!rows.length) {
          stats.bloccati++;
          continue;
        }

        const event = rows[0];

        console.log(
          '\nEvento:', event.id, event.titolo
        );

        let html;

        if (remote) {
          // Ricontrolla l'autorizzazione prima
          // di ogni richiesta.
          const { rows: permissions } =
            await pool.query(`
              SELECT ricerca_abilitata
              FROM public.event_image_sources
              WHERE id = $1
            `, [source.id]);

          if (!permissions[0]?.ricerca_abilitata) {
            stats.bloccati++;
            continue;
          }

          await sleep(DELAY);

          html = await readRemoteHtml(
            item.paginaUrl
          );

        } else {
          html = await fs.readFile(
            localFile, 'utf8'
          );

          if (Buffer.byteLength(html) > MAX_HTML) {
            throw new Error('HTML troppo grande');
          }
        }

        const result = extractEventImages(
          html,
          item.paginaUrl
        );

        if (
          normalizeEventTitle(result.titolo) !==
          normalizeEventTitle(event.titolo)
        ) {
          throw new Error(
            'Titolo non corrispondente'
          );
        }

        stats.elaborati++;

        if (!result.immagini.length) {
          stats.senzaImmagine++;
          continue;
        }

        for (const image of result.immagini) {
          stats.candidate++;

          console.log(
            'Immagine:', image.immagineUrl
          );

          const inserted = await registerCandidate(
            event,
            source,
            image
          );

          stats.inserite += inserted;

          if (apply && inserted === 0) {
            stats.giaPresenti++;
          }
        }

      } catch (error) {
        stats.errori++;

        console.error(
          'Errore evento', item.id,
          error.message
        );
      }
    }
  }

  console.log('\nRIEPILOGO');
  console.table(stats);

  if (stats.errori) {
    process.exitCode = 1;
  }

} catch (error) {
  console.error(error.message);
  process.exitCode = 1;

} finally {
  await pool.end();
}