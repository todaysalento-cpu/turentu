// Eseguire da root progetto: node tests\applica_p0_c6_acceptance.mjs
// Patch fail-closed: backup e sostituzione solo se il file ha gli anchor attesi.
import fs from 'node:fs';
import path from 'node:path';
const target = path.resolve('services/popbus/v2/acceptance.js');
const src = fs.readFileSync(target, 'utf8');
const oldImport = "import { verificaAccettazionePixel } from './popbus-pixel-acceptance-preflight.js';";
const newImport = oldImport + "\nimport { verificaAccettazionePixelMulti } from './popbus-pixel-multi-acceptance-preflight.js';";
const oldBlock = `  const plan = a.piano;
  // PIXEL-first: fail closed prima di qualsiasi conversione o pagamento.
  if (a.pixel_opportunita_id != null) {
    await verificaAccettazionePixel(client, a, plan);
  }
  // P0-C3:`;
const newBlock = `  const plan = a.piano;
  const isMultiPixel = Array.isArray(plan?.missioni) && plan.missioni.length > 1;
  // P0-C6: nessuna opportunita principale obbligatoria nel ciclo multimissione.
  // La verifica controlla tutte le opportunita delle missioni persistite.
  if (isMultiPixel) {
    await verificaAccettazionePixelMulti(client, a, plan);
  } else if (a.pixel_opportunita_id != null) {
    await verificaAccettazionePixel(client, a, plan);
  }
  // P0-C3:`;
if (src.includes('verificaAccettazionePixelMulti')) throw new Error('Patch gia presente: nessuna modifica');
if (src.split(oldImport).length !== 2 || src.split(oldBlock).length !== 2)
  throw new Error('Versione acceptance diversa dagli anchor attesi: nessuna modifica');
const output = src.replace(oldImport, newImport).replace(oldBlock, newBlock);
const backup = target + '.backup-p0-c6';
if (fs.existsSync(backup)) throw new Error('Backup esistente: nessuna modifica');
fs.writeFileSync(backup, src);
fs.writeFileSync(target, output);
console.log('PATCH APPLICATA. Backup:', backup);
console.log('Flag non modificati. Eseguire test prima di qualsiasi attivazione.');
