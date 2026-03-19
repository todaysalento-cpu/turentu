// scripts/extractTypes.ts (CommonJS compatibile)
const fs = require("fs");
const path = require("path");

const rootDirs = ["app", "components"]; // cartelle da scansionare
const outputFile = "types-extracted.ts";

// regex per catturare `export interface` e `export type`
const typeRegex = /export\s+(interface|type)\s+[\w\d_]+\s*[^;{]*[{;][\s\S]*?[\n}];?/gm;

function readFilesRecursively(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(readFilesRecursively(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractTypes(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const matches = content.match(typeRegex);
  return matches || [];
}

function main() {
  let allTypes = [];

  for (const dir of rootDirs) {
    if (!fs.existsSync(dir)) continue; // evita errori se la cartella non esiste
    const files = readFilesRecursively(dir);
    for (const file of files) {
      const types = extractTypes(file);
      if (types.length) {
        allTypes.push(`// From ${file}`);
        allTypes.push(...types, "\n");
      }
    }
  }

  fs.writeFileSync(outputFile, allTypes.join("\n"), "utf-8");
  console.log(`✅ Estratti ${allTypes.length} tipi in ${outputFile}`);
}

main();