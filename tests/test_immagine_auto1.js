import fs from 'fs';
import fetch from 'node-fetch';
import csv from 'csv-parser';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = `${__dirname}/test_dataset`;
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

let done = false;

fs.createReadStream(`${__dirname}/../dataset_auto/Image_table.csv`) // <- percorso corretto
  .pipe(csv())
  .on('data', async (row) => {
    if (done) return;

    const url = row.image_url;
    if (!url) return;

    const filename = url.split('/').pop();
    const filepath = `${OUTPUT_DIR}/${filename}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(filepath, Buffer.from(buffer));
      console.log(`✅ Immagine scaricata: ${filename}`);
      done = true;
    } catch (err) {
      console.log(`❌ Errore con ${url}: ${err.message}`);
    }
  })
  .on('end', () => {
    if (!done) console.log('⚠️ Nessuna immagine valida trovata.');
    else console.log('🎉 Download di test completato!');
  });