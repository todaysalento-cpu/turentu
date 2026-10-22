// tests/test-pixel-hybrid-diagnostica.js
// Diagnostica di sola lettura per la selezione comunale OSM + Turentu.
// Esecuzione dalla root: node --env-file=.env tests/test-pixel-hybrid-diagnostica.js 075088
import { discoverPixelComuneCandidates } from '../services/pixel/pixel-stop-selection-comune.service.js';

const codiceIstat = process.argv[2] ?? '075088';
if (!/^\d{6}$/.test(codiceIstat)) {
  console.error('Uso: node --env-file=.env tests/test-pixel-hybrid-diagnostica.js <ISTAT_6_CIFRE>');
  process.exitCode = 2;
} else {
  console.log('==============================================');
  console.log('PIXEL - DIAGNOSTICA TERRITORIALE IBRIDA');
  console.log('SOLO LETTURA: nessuna fermata registrata');
  console.log('Comune ISTAT:', codiceIstat);
  console.log('==============================================');
  try {
    const result = await discoverPixelComuneCandidates(codiceIstat, { source: 'HYBRID' });
    console.log('Stato:', result.stato);
    console.log('Nodi:', result.nodi ?? 0);
    console.log('Budget:', result.limite, '| Censite:', result.censite, '| Residue:', result.residue);
    console.log('Candidati distinti:', result.candidati_distinti);
    console.log('Selezionati:', result.selezionati.length);
    console.log('Errori:', result.errori.length);
    console.table(result.copertura_nodi ?? []);
    console.table((result.selezionati ?? []).map(c => ({
      fonte: c.fonte ?? 'non specificata', tipo: c.tipo,
      nome: c.nome, nodi_coperti: c.nodi_raggiungibili?.length ?? 0,
      registrabile_automaticamente: c.registrabile_automaticamente === true,
    })));
    if (result.errori.length) console.dir(result.errori, { depth: 4 });
    if (result.stato === 'parziale') process.exitCode = 1;
  } catch (error) {
    console.error('ERRORE PIXEL:', error);
    process.exitCode = 1;
  }
}
