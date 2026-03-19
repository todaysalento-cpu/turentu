// scripts/removeBadImports.js
const fs = require("fs");
const path = require("path");

const rootDirs = ["app", "components"];

const BAD_IMPORTS = [
  "React",
  "Link",
  "Topbar",
  "Modal",
  "Error",
  "Number",
  "Date"
];

function cleanFile(filePath) {
  let content = fs.readFileSync(filePath, "utf-8");

  const regex = /import\s+\{([^}]+)\}\s+from\s+["']@\/types\/global["']/g;

  content = content.replace(regex, (match, imports) => {
    const filtered = imports
      .split(",")
      .map(i => i.trim())
      .filter(i => !BAD_IMPORTS.includes(i));

    if (filtered.length === 0) return "";
    return `import { ${filtered.join(", ")} } from "@/types/global"`;
  });

  fs.writeFileSync(filePath, content);
}

function walk(dir) {
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) return walk(full);
    if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      cleanFile(full);
    }
  });
}

rootDirs.forEach(walk);
console.log("✅ Import puliti");