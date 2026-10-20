/**
 * TURENTU — GATE DI INTEGRAZIONE PIXEL -> POPBUS V2 -> WORKER
 * Diagnostica NON distruttiva. Non importa/esegue worker.js: quel worker puo fare COMMIT
 * ed emettere socket, quindi NON e' sicuro invocarlo dentro una transazione esterna.
 * 1) Analisi statica del worker attualmente installato (non una prova runtime).
 * 2) Lettura reale dei contesti PIXEL tramite adapter POPBUS in transazione READ ONLY.
 * 3) Validazione formazioni e provenienza PIXEL. Nessuna attivazione.
 * Output JSON per automatizzare il successivo collaudo transazionale.
 *
 * Eseguire da project-root:
 * node --env-file=.env tests/test_popbus_v2_gate_integrazione_pixel_worker.js
 */
import { readFile } from 'node:fs/promises';
import { pool } from '../db/db.js';
import { leggiContestiOpportunitaPixel, generaFormazioniDaOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';

const say = (name, data) => console.log(`${name}_JSON:${JSON.stringify(data)}`);
const fail = (m) => { throw new Error(m); };
const MAX_OPPORTUNITA = 1000;
const MAX_FORMAZIONI = 15000;
const MAX_FORMAZIONI_PER_SEED = 80;
let client = null;
let tx = false;
let esito = { analisiStatica: null, letturaReale: null, attivazionePixelOperativaCertificata: false };
try {
  const workerUrl = new URL('../services/popbus/v2/worker.js', import.meta.url);
  const src = await readFile(workerUrl, 'utf8');
  const method = /export\s+async\s+function\s+processaProposteDinamicheV2\s*\(/.exec(src);
  if (!method) fail('Impossibile identificare processaProposteDinamicheV2 nel worker attuale.');
  const start = method.index;
  const selection = /\bconst\s+chosen\s*=\s*scegliAttivazioni\s*\(\s*feasible\s*\)/g;
  const matches = [...src.matchAll(selection)].filter(m => m.index > start);
  const activation = /await\s+client\.query\s*\(\s*['"]BEGIN['"]\s*\)/g;
  const txStarts = [...src.matchAll(activation)].filter(m => m.index > start);
  const pixelReads = [...src.matchAll(/\b(?:leggiOpportunitaPixel|leggiContestiOpportunitaPixel|generaFormazioniDaOpportunitaPixel)\s*\(/g)]
    .filter(m => m.index > start).map(m => ({ nome: m[0].replace(/\s*\($/, ''), offset: m.index }));
  const pixelShadow = /POPBUS_PIXEL_(?:DB_)?SHADOW|PIXEL SHADOW|PIXEL DB SHADOW/.test(src);
  const commit = /await\s+client\.query\s*\(\s*['"]COMMIT['"]\s*\)/.test(src.slice(start));
  const socket = /nuova_proposta_popbus/.test(src.slice(start));
  const selectionOffset = matches[0]?.index ?? null;
  const sourceBeforeSelection = pixelReads.some(p => p.offset < selectionOffset);
  // IMPORTANTE: presenza di letture PIXEL prima del selettore NON dimostra
  // che il loro output alimenti feasible. Non inferire wiring da soli regex.
  const provaWiring = false;
  const architecture = {
    file: 'services/popbus/v2/worker.js',
    funzioneOperativaTrovata: true,
    invocazioniScegliAttivazioniFeasible: matches.length,
    offsetSelezione: selectionOffset,
    chiamateLetturaPixelNelWorker: pixelReads,
    letturePixelPrimaSelezione: sourceBeforeSelection,
    flagShadowPresenti: pixelShadow,
    inizioTransazioni: txStarts.length,
    commitNelWorker: commit,
    socketDopoAttivazionePresente: socket,
    selezioneOperativaDaPixelDimostrata: provaWiring,
    nota: 'Analisi statica conservativa. Un flag shadow o una lettura PIXEL non dimostrano il collegamento a feasible. Il worker NON viene invocato.'
  };
  esito.analisiStatica = architecture;
  say('GATE_ARCHITETTURA', architecture);
  if (!matches.length) fail('Selettore operativo non riconosciuto: serve ispezione manuale, non presumere integrazione.');

  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  tx = true;
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  await client.query("SET LOCAL lock_timeout = '5000ms'");
  const contexts = await leggiContestiOpportunitaPixel({ client, limit: MAX_OPPORTUNITA });
  if (contexts.length >= MAX_OPPORTUNITA) fail('Raggiunto limite opportunita: dataset potenzialmente troncato.');
  const counters = { opportunita: contexts.length, formazioni: 0, seeds: 0,
    senzaFormazioni: 0, richiesteEstranee: 0, fuoriFinestra: 0,
    metadatiIncoerenti: 0, duplicatiNellaOpportunita: 0, richiesteMultiOpportunita: 0,
    attivazioniCreate: 0, campione: [] };
  const requestToOpportunities = new Map();
  const seen = new Set();
  for (const c of contexts) {
    const allowed = new Set((c.richiesta_ids || []).map(Number));
    if (!allowed.size) fail(`Opportunita ${c.pixel_opportunita_id} senza richieste.`);
    for (const id of allowed) {
      if (!Number.isSafeInteger(id) || id <= 0) fail('ID richiesta non valido.');
      const opps = requestToOpportunities.get(id) || new Set();
      opps.add(String(c.pixel_opportunita_id));
      requestToOpportunities.set(id, opps);
    }
    counters.seeds += allowed.size;
    const forms = generaFormazioniDaOpportunitaPixel(c, { maxFormazioniPerSeed: MAX_FORMAZIONI_PER_SEED });
    if (!forms.length) counters.senzaFormazioni++;
    for (const f of forms) {
      if (++counters.formazioni > MAX_FORMAZIONI) fail('Superato limite formazioni: restringere dataset per audit.');
      const ids = (f.evaluation?.requests || []).map(r => Number(r.id));
      if (!ids.length || ids.some(id => !allowed.has(id))) counters.richiesteEstranee++;
      const depart = Number(f.evaluation?.departure);
      if (!Number.isFinite(depart) || depart < Number(c.window.start) || depart > Number(c.window.end)) counters.fuoriFinestra++;
      if (String(f.pixel_opportunita_id) !== String(c.pixel_opportunita_id) ||
          String(f.pixel_direttrice_id) !== String(c.pixel_direttrice_id) ||
          String(f.versione) !== String(c.versione)) counters.metadatiIncoerenti++;
      const key = `${c.pixel_opportunita_id}|${ids.slice().sort((a,b)=>a-b).join(',')}|${depart}`;
      if (seen.has(key)) counters.duplicatiNellaOpportunita++;
      seen.add(key);
    }
    if (counters.campione.length < 8) counters.campione.push({
      pixelOpportunitaId: c.pixel_opportunita_id,
      pixelDirettriceId: c.pixel_direttrice_id,
      versione: c.versione,
      numeroRichieste: allowed.size,
      finestraInizio: new Date(c.window.start).toISOString(),
      finestraFine: new Date(c.window.end).toISOString()
    });
  }
  counters.richiesteMultiOpportunita = [...requestToOpportunities.values()].filter(s => s.size > 1).length;
  esito.letturaReale = counters;
  say('GATE_ADAPTER_REALE', counters);
  if (counters.richiesteEstranee || counters.fuoriFinestra || counters.metadatiIncoerenti || counters.duplicatiNellaOpportunita) {
    fail('Invarianti adapter PIXEL -> POPBUS violati.');
  }
  await client.query('ROLLBACK');
  tx = false;
  console.log('GATE_ROLLBACK_OK: transazione READ ONLY chiusa, nessuna attivazione.');
  say('GATE_ESITO', {
    stato: contexts.length ? 'ADAPTER_VERIFICATO_WORKER_NON_CERTIFICATO' : 'NESSUNA_OPPORTUNITA_ATTUALE_WORKER_NON_CERTIFICATO',
    attivazionePixelOperativaCertificata: false,
    motivo: 'Il worker non viene eseguito perche puo effettuare COMMIT ed emettere socket. Serve un seam transazionale esplicito per testare attivazione reale in rollback.',
    prossimoPasso: 'Ispezionare la costruzione di feasible e il punto di persistenza per collegare PIXEL senza creare direttrici in POPBUS.'
  });
} catch (error) {
  console.error('GATE_ERRORE:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (tx) {
      try { await client.query('ROLLBACK'); console.log('GATE_ROLLBACK_OK: rollback dopo errore.'); }
      catch (error) { console.error('GATE_ROLLBACK_ERRORE:', error.message); process.exitCode = 1; }
    }
    client.release();
  }
  await pool.end();
}
