/**
 * TURENTU POPBUS — TEST 16 / AUDIT ACCEPTANCE REALE
 * SOLO LETTURA: analisi del file reale acceptance.js, nessuna importazione/esecuzione,
 * nessun accesso DB, nessuna chiamata Stripe, nessuna modifica.
 * Salva come tests/test_popbus_audit_acceptance_reale_16.mjs
 * Esegui: node tests/test_popbus_audit_acceptance_reale_16.mjs
 * Exit code 1 solo per FAIL (controllo essenziale mancante).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const file = resolve(root, 'services/popbus/v2/acceptance.js');
const results = { pass: 0, fail: 0, gap: 0 };
const findings = [];
let src = '';
const normalize = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const test = (kind, name, condition, detail = '') => {
  const status = condition ? 'PASS' : kind;
  results[status.toLowerCase()]++;
  console.log(`${status.padEnd(4)} ${name}${!condition && detail ? ' — ' + detail : ''}`);
  findings.push({ status, name, ...(status !== 'PASS' ? { detail } : {}) });
};
const check = (name, condition, detail) => test('FAIL', name, condition, detail);
const gap = (name, condition, detail) => test('GAP', name, condition, detail);
const has = regex => regex.test(src);
const sql = regex => regex.test(src);

console.log('=== TURENTU POPBUS / TEST 16 AUDIT ACCEPTANCE REALE ===');
console.log('MODALITA: AUDIT STATICO DEL SORGENTE / ZERO DB / ZERO STRIPE');
console.log('Sorgente:', file);
if (!existsSync(file)) {
  console.error('FAIL acceptance.js non trovato. Esegui dalla root del backend Turentu.');
  process.exitCode = 1;
} else {
  const raw = readFileSync(file, 'utf8');
  src = normalize(raw);
  check('Funzione reale accettaAttivazione esportata', /export\s+async\s+function\s+accettaAttivazione\s*\(/.test(src), 'Firma non riconosciuta');
  check('Lock advisory transazionale', has(/pg_advisory_xact_lock\s*\(/i), 'Manca lock advisory');
  check('Lock offerta e attivazione', has(/FOR\s+UPDATE\s+OF\s+o\s*,\s*a/i), 'Lock delle righe offerta/attivazione non individuato');
  check('Offerta associata ad autista/account corretto', has(/o\.autista_id\s*=\s*\$\d/i), 'Verifica titolarita offerta non individuata');
  check('Offerta non scaduta e in stato inviato', has(/offer\.expires_at/) && has(/offer\.stato\s*!==\s*['"]inviata['"]/), 'Verifica scadenza/stato non individuata');
  check('Idempotenza accettazione ripetuta', has(/giaAccettata\s*:\s*true/) && has(/offer\.corsa_id/), 'Ritorno idempotente non individuato');
  check('Blocco esplicito multi-missione presente', has(/plan\?\.missioni/) && has(/missioni\.length\s*>\s*1/) && has(/multi-missione non ancora abilitata/), 'NON RIMUOVERE il blocco prima del collaudo reale');
  check('Intervallo busyStart/busyEnd validato', has(/plan\.busyStart/) && has(/plan\.busyEnd/) && has(/busyStart\s*>=\s*busyEnd/), 'Intervallo busy non validato');
  check('Esclusivita verificata sul veicolo, non sul titolare', has(/other\.veicolo_id\s*=\s*\$\d/) && has(/WHERE\s+v\.id\s*=\s*\$\d/i), 'Conflitto per veicolo non riconosciuto');
  check('Controllo capienza basato su peak', has(/posti_totali/) && has(/plan\.evaluation\.peak/), 'Controllo peak non riconosciuto');
  check('Richieste bloccate FOR UPDATE', has(/FOR\s+UPDATE\s+OF\s+r\s*,\s*ar/i), 'Lock richieste non riconosciuto');
  check('Richieste convertite non riaccettabili', has(/r\.stato\s*!==\s*['"]in_lavorazione['"]/) && has(/r\.corsa_id\s*!=\s*null/), 'Verifica stato richieste non riconosciuta');
  check('Fingerprint delle richieste verificato', has(/fingerprintRichiesta\s*\(/) && has(/requestSnapshot/), 'Controllo snapshot non riconosciuto');
  check('Verifica autorizzazione Stripe/wallet prima di INSERT', has(/await\s+verificaPagamento\s*\(/) && has(/paymentIntents\.retrieve\s*\(/), 'Verifica pagamento non riconosciuta');
  check('Una INSERT corse nel flusso di acceptance', (src.match(/INSERT\s+INTO\s+corse\s*\(/gi) || []).length === 1, 'Numero di INSERT corse inatteso');
  check('INSERT prenotazioni e pagamenti', sql(/INSERT\s+INTO\s+prenotazioni\s*\(/i) && sql(/INSERT\s+INTO\s+pagamenti\s*\(/i), 'INSERT non individuati');
  check('Prenotazioni e pagamenti condividono corsa.id', has(/corsa\.id/) && has(/prenotazione_id/) && has(/corsa_id/), 'Link corsa non riconosciuto');
  check('Attivazione collegata a corsa e confermata', sql(/UPDATE\s+popbus_attivazioni[\s\S]*?SET\s+stato\s*=\s*['"]confermata['"][\s\S]*?corsa_id\s*=/i), 'UPDATE attivazione non riconosciuto');
  check('Geometria: almeno due punti per leg', has(/polyline\.decode/) && has(/decoded\.length\s*<\s*2/), 'Controllo geometria non riconosciuto');
  check('Calcolo offset con turf.length', has(/turf\.length\s*\(/) && has(/offsets\.push\s*\(/), 'Calcolo metrico non riconosciuto');
  check('Acceptance non apre autonomamente transazione', !/client\.query\s*\(\s*['"`]\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(src), 'Il router deve gestire BEGIN/COMMIT/ROLLBACK');

  // GAP: condizioni che l'audit statico NON puo validare o che richiedono evoluzione.
  gap('Conflitti con attivazioni in attesa', /other\.stato\s+IN\s*\([\s\S]*?in_attesa_autista[\s\S]*?confermata/i.test(src), 'La query potrebbe controllare solo confermata: valutare se offerte pendenti debbano riservare il veicolo');
  gap('Intervallo busy completo delle corse esistenti', /c\.busyStart|c\.busy_start|c\.piano\s*->>\s*['"]busyStart/.test(src), 'corse.start_datetime/arrivo_datetime descrivono la corsa commerciale, non necessariamente avvicinamento e ritorno');
  gap('Capienza multi-missione per segmenti nel percorso acceptance', /occupazionePerLeg|occupazioneSegmenti|postiPerSegmento|validazioneCapienza/.test(src), 'Il peak e verificato ma il percorso multi e bloccato; serviranno controlli per segmento');
  gap('Coerenza indici globali contro piano multi-missione', /indiceGlobaleSalita|indice_salita_globale|globalPickupIndex|globalStartIndex/.test(src), 'Oggi l acceptance usa gli indici di popbus_attivazione_richieste; mapping multi da integrare');
  gap('Verifica coerenza cardinalita nodi/legs/times', /legs\.length\s*[!=]==?\s*coordinates\.length\s*-\s*1|coordinates\.length\s*[!=]==?\s*legs\.length\s*\+\s*1/.test(src), 'Rischio indici/offset se piano JSONB incoerente');
  gap('Gestione esplicita missioni nella acceptance', /popbus_attivazione_missioni|popbus_missione_richieste/.test(src), 'Il codice attuale non sembra verificare le righe missione durante acceptance');
  gap('Transazione effettiva del router', false, 'Il sorgente delega BEGIN/COMMIT/ROLLBACK al router: controllare il chiamante reale');
  gap('Concorrenza e rollback PostgreSQL reale', false, 'Richiede test integrato su DB di prova, non audit statico');
  gap('Capture Stripe e riconciliazione reali', false, 'Nessuna API invocata: richiede ambiente Stripe test');
  gap('Confronto semantico totale passeggeri vs peak', /posti_prenotati\s*=\s*\$\d[\s\S]{0,100}posti_disponibili\s*=\s*posti_totali\s*-\s*\$\d/.test(src) && false, 'Somma prenotati e peak simultaneo hanno semantiche diverse; verificare lettori e UI');

  console.log('\nRIEPILOGO', JSON.stringify({ ...results, file: 'services/popbus/v2/acceptance.js', mode: 'AUDIT STATICO / NESSUNA SCRITTURA', findings: findings.filter(x => x.status !== 'PASS') }, null, 2));
  console.log(`ESITO: ${results.pass} PASS, ${results.fail} FAIL, ${results.gap} GAP. Nessuna scrittura.`);
  if (results.fail) process.exitCode = 1;
}
