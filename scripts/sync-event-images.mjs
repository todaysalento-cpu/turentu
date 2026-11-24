import 'dotenv/config';
import fs from 'node:fs/promises';
import { pool } from '../db/db.js';
import {
  optimizeEventImage,
  uploadEventImage
} from '../services/eventi/event-image.service.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');

function arg(name) {
  return args.find(a => a.startsWith(name + '='))
    ?.slice(name.length + 1);
}

async function main() {
  const rawIds = arg('--event-ids') || '';
  const file = arg('--file');

  const ids = [...new Set(
    rawIds.split(',').map(Number)
  )];

  if (
    !file ||
    !ids.length ||
    ids.some(id =>
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      id > 2147483647
    )
  ) {
    throw new Error(
      'Specificare --event-ids=21,22 --file=immagine.jpg'
    );
  }

  const { rows } = await pool.query(`
    SELECT id, titolo, categoria, immagine_url
    FROM public.eventi
    WHERE id = ANY($1::int[])
    ORDER BY id
  `, [ids]);

  if (rows.length !== ids.length) {
    throw new Error('Uno o piu eventi non esistono');
  }

  const eligible = rows.filter(
    e => !e.immagine_url?.trim()
  );

  console.table(rows.map(e => ({
    id: e.id,
    titolo: e.titolo,
    azione: e.immagine_url?.trim()
      ? 'PRESERVATA'
      : 'DA AGGIORNARE'
  })));

  if (!eligible.length) {
    console.log('Nessun evento da aggiornare');
    return;
  }

  const input = await fs.readFile(file);
  const optimized = await optimizeEventImage(input);

  console.log({
    modalita: apply ? 'APPLY' : 'DRY-RUN',
    originale: input.length,
    ottimizzata: optimized.bytes,
    hash: optimized.hash,
    eventi: eligible.map(e => e.id)
  });

  if (!apply) {
    console.log('Nessuna modifica effettuata');
    return;
  }

  const uploaded = await uploadEventImage(input);

  const result = await pool.query(`
    UPDATE public.eventi
    SET immagine_url = $1
    WHERE id = ANY($2::int[])
      AND NULLIF(TRIM(immagine_url), '') IS NULL
    RETURNING id, titolo, immagine_url
  `, [
    uploaded.url,
    eligible.map(e => e.id)
  ]);

  console.table(result.rows);

  console.log({
    aggiornati: result.rowCount,
    url: uploaded.url
  });
}

try {
  await main();
} catch (error) {
  console.error('[EVENT IMAGES]', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}