// Diagnostica statica, sola lettura. Non importa il worker e non accede al DB.
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const file = path.join(root, 'services/popbus/v2/worker.js');
const src = fs.readFileSync(file, 'utf8');
const checks = {
  flagPixelFirst: /POPBUS_PIXEL_FIRST/.test(src),
  gateFailClosed: /if\s*\(POPBUS_PIXEL_FIRST\)\s*\{\s*throw new Error\(['"]POPBUS_PIXEL_FIRST_NON_ABILITATO/.test(src),
  generatoreLegacy: /for\s*\(const c of generaCandidate\(requests\)\)/.test(src),
  letturaFormazioniPixelOperativa: /leggiFormazioniPixelWorker\s*\(/.test(src),
  bridgeFattibilitaOperativo: /preparaInputFattibilitaPixel\s*\(/.test(src),
  sceltaAttivazioni: /scegliAttivazioni\(feasible\)/.test(src),
  scritturaDirettriciLegacy: /INSERT\s+INTO\s+direttrici_virtuali/i.test(src),
  persistenzaMissioni: /registraMissioniAttivazione\s*\(/.test(src),
  scritturaOfferte: /INSERT\s+INTO\s+offerte_autisti/i.test(src),
};
console.log('PIXEL_WORKER_BOUNDARIES_JSON:' + JSON.stringify({file, checks}));
if (!checks.flagPixelFirst || !checks.gateFailClosed) {
  console.error('FAIL: il cutover non e protetto; NON avviare il worker');
  process.exitCode = 1;
} else if (checks.generatoreLegacy || checks.scritturaDirettriciLegacy || !checks.letturaFormazioniPixelOperativa || !checks.bridgeFattibilitaOperativo) {
  console.log('STATO: CUTOVER_NON_PRONTO - non abilitare POPBUS_PIXEL_FIRST');
} else {
  console.log('STATO: ANALISI_MANUALE_NECESSARIA - il test statico non certifica il cutover');
}
