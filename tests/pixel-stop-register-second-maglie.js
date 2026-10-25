// tests/pixel-stop-register-second-maglie.js
// Registrazione controllata di una seconda fermata reale a Maglie.
// Default: sola anteprima. Scrive nel DB SOLO con --commit esplicito.
//
// Uso:
//   node --env-file=.env tests/pixel-stop-register-second-maglie.js
//   node --env-file=.env tests/pixel-stop-register-second-maglie.js --commit
//
// Lo script richiede i dati reali della fermata via prompt.
// Non inventa coordinate, indirizzi o fonti. Non usa Google Places.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pool } from '../db/db.js';
import { getPixelStopBudget } from '../services/pixel/pixel-stop-budget.service.js';
import { registraFermataTerritorialePixel } from '../services/pixel/pixel-territorial-orchestrator.service.js';

const NODE_ID = 5;
const SOURCES = new Set([
  'rilievo_operatore',
  'fonte_pubblica_riutilizzabile'
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCoordinate(value, name, min, max) {
  const number = Number(String(value).trim().replace(',', '.'));
  assert(Number.isFinite(number) && number >= min && number <= max,
    `${name} non valida`);
  return number;
}

function validate(data) {
  assert(data.nodo_territoriale_id === NODE_ID,
    'La fermata deve appartenere al nodo territoriale 5 (Maglie)');
  assert(typeof data.nome === 'string' && data.nome.trim(),
    'Nome fermata obbligatorio');
  assert(typeof data.indirizzo === 'string' && data.indirizzo.trim(),
    'Indirizzo obbligatorio');
  assert(Number.isFinite(data.lat) && data.lat >= -90 && data.lat <= 90,
    'Latitudine non valida');
  assert(Number.isFinite(data.lon) && data.lon >= -180 && data.lon <= 180,
    'Longitudine non valida');
  assert(SOURCES.has(data.fonte), 'Fonte non ammessa');
  assert(typeof data.riferimento_fonte === 'string' &&
    data.riferimento_fonte.trim(), 'Riferimento della fonte obbligatorio');
  assert(data.autorizzazione_uso_dati === true,
    'Devi confermare i diritti di riutilizzo dei dati');
  assert(data.conferma_punto_salita === true,
    'Devi confermare che il punto è realmente utilizzabile per salita/discesa');
  assert(!/^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(data.nome),
    'Non sono ammessi nomi sintetici o di test');
  return data;
}

async function askYesNo(rl, prompt) {
  const answer = (await rl.question(`${prompt} (s/n): `)).trim().toLowerCase();
  return answer === 's' || answer === 'si' || answer === 'sì';
}

async function main() {
  const commit = process.argv.includes('--commit');
  const rl = readline.createInterface({ input, output });

  try {
    console.log('\n=== PIXEL: REGISTRAZIONE SECONDA FERMATA MAGLIE ===');
    console.log(`Nodo territoriale fisso: ${NODE_ID}`);
    console.log('Prima fermata esistente: ID 14 — Maglie, Piazzale Megapark');
    console.log('Modalità:', commit ? 'COMMIT (scrittura richiesta)' : 'DRY RUN (sola anteprima)');
    console.log('Non usare dati Google Places. Inserire un punto reale e una fonte documentabile.\n');

    const nome = (await rl.question('Nome reale della fermata: ')).trim();
    const indirizzo = (await rl.question('Indirizzo preciso: ')).trim();
    const lat = parseCoordinate(await rl.question('Latitudine: '), 'Latitudine', -90, 90);
    const lon = parseCoordinate(await rl.question('Longitudine: '), 'Longitudine', -180, 180);

    console.log('\nFonte consentita:');
    console.log('1) rilievo_operatore');
    console.log('2) fonte_pubblica_riutilizzabile');
    const sourceChoice = (await rl.question('Seleziona 1 o 2: ')).trim();
    const fonte = sourceChoice === '1'
      ? 'rilievo_operatore'
      : sourceChoice === '2'
        ? 'fonte_pubblica_riutilizzabile'
        : null;
    assert(fonte, 'Scelta fonte non valida');

    const riferimento_fonte = (await rl.question(
      'Riferimento documentabile del rilievo/fonte (non lasciare vuoto): '
    )).trim();

    const autorizzazione_uso_dati = await askYesNo(
      rl, 'Confermi di avere i diritti per usare questi dati?'
    );
    const conferma_punto_salita = await askYesNo(
      rl, 'Confermi che il punto è fisicamente adatto a salita/discesa?'
    );

    const dati = validate({
      nodo_territoriale_id: NODE_ID,
      nome,
      indirizzo: indirizzo || null,
      lat,
      lon,
      fonte,
      riferimento_fonte,
      autorizzazione_uso_dati,
      conferma_punto_salita
    });

    const budget = await getPixelStopBudget(NODE_ID);
    console.log('\n=== PRECHECK ===');
    console.log({
      nodo: 'Maglie, LE, Italia',
      codice_istat_comune: budget.codice_istat_comune,
      limite: budget.limite,
      censite: budget.censite,
      residue: budget.residue,
      modalita: commit ? 'COMMIT' : 'DRY_RUN'
    });

    if (!commit) {
      console.log('\nDRY RUN: nessuna scrittura eseguita.');
      console.log('Per eseguire la registrazione, rilancia lo script con --commit.');
      console.log('I dati della fermata non sono stati salvati.');
      return;
    }

    const confirmed = await askYesNo(
      rl, 'Confermi la scrittura nel database con i dati appena inseriti?'
    );
    if (!confirmed) {
      console.log('Annullato: nessuna registrazione richiesta.');
      return;
    }

    const result = await registraFermataTerritorialePixel(dati);

    console.log('\n=== ESITO REGISTRAZIONE ===');
    console.log({
      inserted: result.inserted ?? null,
      reason: result.reason ?? null,
      id: result.id ?? result.fermata_id ?? null,
      existing_id: result.existing_id ?? null,
      fonte_registrata: result.fonte_registrata ?? null,
      attiva: result.attiva ?? null,
      verificata: result.verificata ?? null,
      attivazione_provvisoria: result.attivazione_provvisoria ?? null,
      budget_residuo: result.budget?.residue ?? null
    });
  } finally {
    rl.close();
  }
}

try {
  await main();
} catch (error) {
  console.error('\n[PIXEL REGISTRAZIONE] ERRORE:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
