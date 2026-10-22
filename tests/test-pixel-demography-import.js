// tests/test-pixel-demography-import.js
import { importaDemografiaMinisteroSalute2024 } from '../services/pixel/pixel-demography-import.service.js';
import { pool } from '../db/db.js';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) {
  console.error('Uso: node tests\\test-pixel-demography-import.js data\\istat\\ASL_comuni_popolazione_2024.csv [--apply]');
  process.exit(1);
}
try {
  const risultato = await importaDemografiaMinisteroSalute2024(file, { apply });
  console.log(`PIXEL DEMOGRAFIA - ${risultato.modalita}`);
  console.table(risultato.comuni.map(x => ({
    nodo: x.nodoId, comune: x.comune, istat: x.codice,
    popolazione: x.popolazione, anno: x.anno, max_fermate_auto: x.maxFermate,
  })));
  console.log('Lucugnano (nodo 1): non importato, richiede dati della frazione.');
} catch (err) {
  console.error('IMPORTAZIONE INTERROTTA:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
