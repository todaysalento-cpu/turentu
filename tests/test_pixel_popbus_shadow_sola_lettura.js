// TURENTU — Diagnostica PIXEL -> POPBUS V2 (modulo reale).
// NON importa worker.js e NON esegue attivazioni.
// PostgreSQL BEGIN READ ONLY + ROLLBACK anche in caso di errore.
import { pool } from '../db/db.js';
import {
  leggiContestiOpportunitaPixel,
  generaFormazioniDaOpportunitaPixel
} from '../services/popbus/v2/pixel-opportunity-adapter.js';

const MAX_OPPORTUNITA = 1000;
const MAX_LOG = 20;
let client;
let inTransaction = false;
try {
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  inTransaction = true;
  // Evita che una diagnostica resti bloccata indefinitamente sul DB.
  await client.query("SET LOCAL statement_timeout = '15000ms'");
  const contexts = await leggiContestiOpportunitaPixel({ client, limit: MAX_OPPORTUNITA });
  if (contexts.length === MAX_OPPORTUNITA) {
    throw new Error(`Limite ${MAX_OPPORTUNITA} raggiunto: dataset potenzialmente troncato; nessun risultato dichiarato completo`);
  }
  const totals = {
    opportunita: contexts.length, seeds: 0, formazioni: 0,
    duplicati: 0, fuoriFinestra: 0, richiesteEstranee: 0,
    opportunitaSenzaFormazioni: 0, formazioniPassate: 0,
    scritture: 0
  };
  const globalSeen = new Set();
  for (const context of contexts) {
    const allowed = new Set(context.richiesta_ids.map(Number));
    const formations = generaFormazioniDaOpportunitaPixel(context);
    totals.seeds += allowed.size;
    if (!formations.length) totals.opportunitaSenzaFormazioni++;
    for (const f of formations) {
      totals.formazioni++;
      const ids = f.evaluation.requests.map(r => Number(r.id));
      if (ids.some(id => !allowed.has(id))) totals.richiesteEstranee++;
      if (f.evaluation.departure < context.window.start ||
          f.evaluation.departure > context.window.end) totals.fuoriFinestra++;
      if (f.pixel_opportunita_id !== context.pixel_opportunita_id ||
          f.pixel_direttrice_id !== context.pixel_direttrice_id ||
          f.versione !== context.versione) {
        throw new Error(`Metadati PIXEL incoerenti nell'opportunita ${context.pixel_opportunita_id}`);
      }
      const key = `${f.pixel_opportunita_id}|${ids.slice().sort((a,b)=>a-b).join(',')}|${f.evaluation.departure}`;
      if (globalSeen.has(key)) totals.duplicati++;
      globalSeen.add(key);
      if (f.evaluation.departure > Date.now()) totals.formazioniPassate++;
    }
  }
  if (totals.duplicati || totals.fuoriFinestra || totals.richiesteEstranee) {
    throw new Error(`Vincoli violati: ${JSON.stringify(totals)}`);
  }
  console.log('PIXEL -> POPBUS SHADOW SOLA LETTURA OK:', totals);
  console.log('OPPORTUNITA CAMPIONE:', contexts.slice(0, MAX_LOG).map(c => ({
    id: c.pixel_opportunita_id, direttrice: c.pixel_direttrice_id,
    versione: c.versione, richieste: c.richiesta_ids,
    inizio: new Date(c.window.start).toISOString(),
    fine: new Date(c.window.end).toISOString()
  })));
  console.log('NOTA: non verifica disponibilita veicoli, pagamenti, costi o attivazione; non esegue il worker.');
} catch (error) {
  console.error('PIXEL -> POPBUS SHADOW ERRORE:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK ESEGUITO: transazione di sola lettura chiusa.');
      } catch (error) {
        console.error('ROLLBACK ERROR:', error.message);
        process.exitCode = 1;
      }
    }
    client.release();
  }
  await pool.end();
}
