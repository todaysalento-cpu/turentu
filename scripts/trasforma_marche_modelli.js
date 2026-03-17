// scripts/trasforma_marche_modelli.js
import fs from 'fs';
import path from 'path';

// Percorso JSON originale da CarQuery
const fileInput = path.resolve('data/marche_modelli.json');
const fileOutput = path.resolve('data/marche_modelli_array.json');

if (!fs.existsSync(fileInput)) {
  console.error('❌ JSON originale non trovato:', fileInput);
  process.exit(1);
}

// Legge JSON originale
const raw = fs.readFileSync(fileInput, 'utf-8');
const data = JSON.parse(raw);

// Trasforma in array
const marcheArray = Object.entries(data).map(([marca, modelli]) => ({
  id: marca.toLowerCase().replace(/\s+/g, '_'), // id univoco, minuscolo
  nome: marca,
  modelli: modelli.map(mod => ({
    nome: mod,
    tipo: 'Altro', // puoi mappare tipi reali se vuoi
  })),
}));

// Salva JSON trasformato
fs.writeFileSync(fileOutput, JSON.stringify(marcheArray, null, 2));
console.log(`✅ JSON trasformato salvato in: ${fileOutput} (${marcheArray.length} marche)`);