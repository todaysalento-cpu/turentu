// Destinazione: tests/pixel-stop-manual-registration.js
// Registrazione manuale controllata. Nessuna integrazione Google Places.
// Default: anteprima sola lettura. Scrittura SOLO con --commit esplicito.
import { readFile } from 'node:fs/promises';
import { pool } from '../db/db.js';
import { getPixelStopBudget } from '../services/pixel/pixel-stop-budget.service.js';
import { registraFermataTerritorialePixel } from '../services/pixel/pixel-territorial-orchestrator.service.js';

function assert(ok, message) { if (!ok) throw new Error(message); }
function validate(d) {
  assert(d && typeof d === 'object' && !Array.isArray(d), 'JSON oggetto obbligatorio');
  assert(Number.isSafeInteger(d.nodo_territoriale_id) && d.nodo_territoriale_id > 0, 'nodo_territoriale_id non valido');
  assert(typeof d.nome === 'string' && d.nome.trim().length > 0, 'nome obbligatorio');
  assert(Number.isFinite(d.lat) && d.lat >= -90 && d.lat <= 90, 'lat non valida');
  assert(Number.isFinite(d.lon) && d.lon >= -180 && d.lon <= 180, 'lon non valida');
  assert(['rilievo_operatore', 'fonte_pubblica_riutilizzabile'].includes(d.fonte), 'fonte non ammessa');
  assert(typeof d.riferimento_fonte === 'string' && d.riferimento_fonte.trim(), 'riferimento_fonte obbligatorio');
  assert(d.autorizzazione_uso_dati === true, 'autorizzazione_uso_dati deve essere true');
  assert(d.conferma_punto_salita === true, 'conferma_punto_salita deve essere true');
  assert(d.indirizzo === undefined || d.indirizzo === null || typeof d.indirizzo === 'string', 'indirizzo non valido');
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 1 || (args.length === 2 && args[1] === '--commit'),
    'Uso: node --env-file=.env tests/pixel-stop-manual-registration.js percorso.json [--commit]');
  const commit = args.includes('--commit');
  const dati = validate(JSON.parse(await readFile(args[0], 'utf8')));
  const budget = await getPixelStopBudget(dati.nodo_territoriale_id);
  // Nessuna coordinata o nome nei log. Nessun dato Google deve essere passato in input.
  console.log('[PIXEL REGISTRAZIONE] preflight', { comune: budget.codice_istat_comune,
    limite: budget.limite, censite: budget.censite, residue: budget.residue,
    modalita: commit ? 'COMMIT' : 'DRY_RUN' });
  if (!commit) {
    console.log('[PIXEL REGISTRAZIONE] nessuna scrittura. Per registrare, ripetere con --commit');
    return;
  }
  // Il servizio transazionale ricontrolla budget e duplicati sotto lock.
  const result = await registraFermataTerritorialePixel(dati);
  console.log('[PIXEL REGISTRAZIONE] esito', {
    inserted: result.inserted, reason: result.reason ?? null,
    id: result.id ?? null, existing_id: result.existing_id ?? null,
    residue: result.budget?.residue ?? null,
  });
}

try { await main(); }
catch (error) { console.error('[PIXEL REGISTRAZIONE] errore:', error.message); process.exitCode = 1; }
finally { await pool.end(); }
