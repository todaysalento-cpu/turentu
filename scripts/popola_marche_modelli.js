import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const OUTPUT_FILE = path.resolve('data/marche_modelli.json');

function parseJSONP(text) {
  return JSON.parse(text.replace(/^\?\(|\);$/g, ''));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function popolaJSON() {

  const urlMakes = 'https://www.carqueryapi.com/api/0.3/?cmd=getMakes&sold_in_us=1&callback=?';

  const resMakes = await fetch(urlMakes);
  const textMakes = await resMakes.text();
  const dataMakes = parseJSONP(textMakes);

  const marche = dataMakes.Makes || [];

  console.log("Marche trovate:", marche.length);

  const risultato = {};

  for (const m of marche) {

    console.log("🔎", m.make_display);

    try {

      const urlModels = `https://www.carqueryapi.com/api/0.3/?cmd=getModels&make=${encodeURIComponent(m.make_id)}&callback=?`;

      const resModels = await fetch(urlModels);
      const textModels = await resModels.text();
      const dataModels = parseJSONP(textModels);

      const models = (dataModels.Models || []).map(mod => mod.model_name);

      risultato[m.make_display] = models;

      console.log("   modelli:", models.length);

    } catch {
      risultato[m.make_display] = [];
      console.log("   errore modelli");
    }

    await sleep(150);
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(risultato)
  );

  console.log("✅ JSON ottimizzato salvato");
}

popolaJSON();