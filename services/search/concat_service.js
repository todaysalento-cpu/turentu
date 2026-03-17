import fs from 'fs';
import path from 'path';

// Se esegui da dentro "search":
const baseDir = process.cwd();
const outputFile = path.join(baseDir, 'services.concat.js');

function getAllJsFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(getAllJsFiles(fullPath));
    } else if (
      item.isFile() &&
      item.name.endsWith('.js') &&
      item.name !== path.basename(outputFile) // ignora il file concat
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = getAllJsFiles(baseDir);

if (files.length === 0) {
  console.log('⚠️ Nessun file JS trovato da concatenare.');
  process.exit(0);
}

let concatenated = '';
files.forEach(file => {
  const content = fs.readFileSync(file, 'utf-8');
  concatenated += `\n// --- ${path.relative(baseDir, file)} ---\n`;
  concatenated += content + '\n';
});

fs.writeFileSync(outputFile, concatenated);
console.log(`✅ Concatenati ${files.length} file in: ${outputFile}`);
