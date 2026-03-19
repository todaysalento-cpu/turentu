// tests/concatAutista.js
const fs = require('fs');
const path = require('path');

const folder = path.join(process.cwd(), 'app', 'autista'); // cartella principale autista
const outputFile = path.join(process.cwd(), 'autista-concatenato.tsx');

// funzione ricorsiva per prendere tutti i file .tsx
function getAllFiles(dir, ext, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      getAllFiles(fullPath, ext, fileList);
    } else if (file.endsWith(ext)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// prendi tutti i file .tsx nella cartella e sottocartelle
let tsxFiles = getAllFiles(folder, '.tsx');

// ordina alfabeticamente
tsxFiles.sort();

let combined = '';

tsxFiles.forEach(file => {
  // percorso relativo da "app/autista" (anche per root)
  const relativePath = path.relative(folder, file);
  const content = fs.readFileSync(file, 'utf8');
  combined += `\n// ===== FILE: ${relativePath} =====\n\n`;
  combined += content + '\n';
});

// scrivi il file finale
fs.writeFileSync(outputFile, combined, 'utf8');

console.log(`✅ Tutti i file TSX di app/autista (root + sottocartelle) concatenati in: ${outputFile}`);
