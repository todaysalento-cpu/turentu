import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import csv from 'csv-parser';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'test_dataset');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Leggi tutte le righe del CSV prima di fare il download
const rows = [];
fs.createReadStream(path.join(__dirname, '../dataset_auto/Image_table.csv'))
  .pipe(csv())
  .on('data', (row) => rows.push(row))
  .on('end', async () => {
    console.log(`✅ Trovate ${rows.length} immagini da scaricare.`);

    for (const row of rows) {
      const url = row.image_url; // Adatta al nome esatto della colonna
      if (!url) continue;

      const filename = path.basename(url);
      const filepath = path.join(OUTPUT_DIR, filename);

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(filepath, Buffer.from(buffer));
        console.log(`✅ Scaricata: ${filename}`);
      } catch (err) {
        console.log(`❌ Errore con: ${url}`, err.message);
      }
    }

    console.log('🎉 Download completato!');
  });