// TURENTU - diagnostica statica Modello A, SOLA LETTURA.
// Rinomina .txt in .mjs, salva in tests/, esegui da project-root.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = {
  pricing: 'utils/pricing.util.js',
  search: 'services/search/search.service.js',
  formatter: 'services/search/formatter/search.formatter.js',
  booking: 'routes/booking.routes.js',
};
function findFile(relative, fallbackName) {
  const candidate = path.join(root, relative);
  if (fs.existsSync(candidate)) return candidate;
  // Route might be in routes/booking.routes.js or other directory.
  if (fallbackName === 'booking.routes.js') {
    for (const alt of ['booking.routes.js', 'routes/booking.routes.js', 'routes/booking/booking.routes.js']) {
      const p = path.join(root, alt);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const source = {};
for (const [key, rel] of Object.entries(files)) {
  const filename = findFile(rel, path.basename(rel));
  if (!filename) {
    console.error(`FILE NON TROVATO: ${rel}. Correggi il percorso nella costante files.`);
    process.exitCode = 2;
    continue;
  }
  source[key] = fs.readFileSync(filename, 'utf8');
  console.log(`LETTO ${key}: ${path.relative(root, filename)}`);
}
if (Object.keys(source).length !== 4) process.exit(2);
const results = [];
const record = (check, outcome, note) => results.push({ controllo: check, esito: outcome, dettaglio: note });
record('Helper Modello A nel pricing', /ripartisciCondivisaModelloA/.test(source.pricing) ? 'PRESENTE' : 'ASSENTE', 'Controllo statico');
record('Attivazione ramo modelloA', /corsa\?\.modelloA|corsa\.modelloA/.test(source.pricing) ? 'PRESENTE' : 'DA VERIFICARE', 'Controllo statico');
record('Snapshot costruito in search', /modelloA\s*:|\.modelloA\s*=/.test(source.search) ? 'RIFERIMENTO TROVATO' : 'NON VISIBILE', 'Non esclude snapshot già nella cache');
record('Snapshot costruito nel formatter', /modelloA\s*:|\.modelloA\s*=/.test(source.formatter) ? 'RIFERIMENTO TROVATO' : 'NON VISIBILE', 'Non esclude dati ereditati');
record('Formatter chiama calcolaPrezzo', /await\s+calcolaPrezzo\s*\(/.test(source.formatter) ? 'PRESENTE' : 'NON VISIBILE', 'Controllo statico');
const rounding = source.formatter.match(/function\s+arrotondaPrezzo\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
record('Arrotondamento a euro intero', /Math\.ceil\s*\(\s*n\s*\)/.test(rounding) ? 'CONFERMATO' : 'DA VERIFICARE', 'Controllare l’effetto sul Modello A');
record('Booking verifica quotazione', /cercaSlotUltra/.test(source.booking) && /quotation\.prezzo/.test(source.booking) ? 'PRESENTE' : 'DA VERIFICARE', 'Prezzo ricalcolato dalla ricerca');
record('Booking inserisce pending', /INSERT\s+INTO\s+pending/i.test(source.booking) ? 'PRESENTE' : 'NON VISIBILE', 'Controllo statico');
record('Booking persiste snapshot', /modelloA|costoCommercialeMissione|kmPrimaPrenotazione/.test(source.booking) ? 'RIFERIMENTO TROVATO' : 'NON VISIBILE', 'Non esclude logica in altri servizi');
record('Booking usa capture manuale', /capture_method\s*:\s*['"]manual['"]/.test(source.booking) ? 'PRESENTE' : 'NON VISIBILE', 'Non verifica lo stato Stripe reale');
console.log('\n=== TURENTU | DIAGNOSTICA INTEGRAZIONE MODELLO A (SOLA LETTURA) ===');
console.table(results);
const quote = [39.85, 19.92, 63.76];
console.log('Esempio A+B+C: quote Modello A:', quote, 'somma', quote.reduce((a,b)=>a+b,0).toFixed(2));
console.log('Esempio formatter attuale (Math.ceil):', quote.map(Math.ceil), 'somma', quote.map(Math.ceil).reduce((a,b)=>a+b,0).toFixed(2));
console.log('ATTENZIONE: controllo statico, NON prova esecuzione reale, persistenza DB, concorrenza o Stripe.');
console.log('NESSUNA SCRITTURA: database, backend e Stripe non vengono modificati.');
