// PIXEL territoriale SHADOW: scheduling persistente, audit aggregato, lock per comune.
// Richiede la migration 001_pixel_territorial_runs.sql.
import { pool } from '../../db/db.js';
import { diagnosticaFermateComunePixel } from './pixel-territorial-orchestrator.service.js';

const LOCK_NAMESPACE = 'turentu:pixel:territorial:shadow:';
const MAX_COMUNI = 1000;
export function parsePixelTerritorialConfig(env = process.env) {
  const mode = String(env.PIXEL_TERRITORIAL_MODE ?? 'OFF').trim().toUpperCase();
  if (!['OFF', 'SHADOW'].includes(mode)) throw new Error('Modalita non supportata: OFF o SHADOW');
  const raw = String(env.PIXEL_TERRITORIAL_COMUNI ?? 'AUTO').trim();
  const auto = !raw || raw.toUpperCase() === 'AUTO';
  const comuni = auto ? [] : [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  if (comuni.some(c => !/^\d{6}$/.test(c))) throw new Error('Codici ISTAT non validi');
  if (comuni.length > MAX_COMUNI) throw new Error('Troppi comuni configurati');
  const intervalHours = Number(env.PIXEL_TERRITORIAL_INTERVAL_HOURS ?? 24);
  if (!Number.isFinite(intervalHours) || intervalHours < 24 || intervalHours > 720) {
    throw new Error('Intervallo non valido: minimo 24 ore, massimo 720');
  }
  return { mode, auto, comuni, intervalMs: intervalHours * 3600_000 };
}

export async function runPixelTerritorialCycle(config, {
  database = pool, diagnostic = diagnosticaFermateComunePixel,
  logger = console, now = () => new Date(),
} = {}) {
  const summary = { mode: config.mode, eseguiti: 0, saltati: 0, errori: 0,
    scritture_fermate: 0, scritture_audit: 0 };
  if (config.mode === 'OFF') return summary;
  if (config.mode !== 'SHADOW') throw new Error('Runner esclusivamente SHADOW');
  const comuni = config.auto ? (await database.query(`
    SELECT codice_istat_comune FROM public.pixel_budget_comunali
    ORDER BY codice_istat_comune LIMIT $1`, [MAX_COMUNI + 1])).rows.map(r => r.codice_istat_comune) : config.comuni;
  if (comuni.length > MAX_COMUNI) throw new Error('Troppi comuni: aumentare limite esplicitamente');
  for (const comune of comuni) {
    const client = await database.connect();
    const lockKey = LOCK_NAMESPACE + comune;
    let locked = false;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockKey]);
      locked = lock.rows[0]?.acquired === true;
      if (!locked) { summary.saltati++; logger.info('[PIXEL TERRITORIALE] lock occupato', { comune }); continue; }
      // Check di scadenza effettuato sotto lo stesso lock interprocesso.
      const due = await client.query(`SELECT prossimo_tentativo
        FROM public.pixel_territorial_runs WHERE codice_istat_comune=$1`, [comune]);
      const currentTime = now();
      if (due.rows[0]?.prossimo_tentativo && new Date(due.rows[0].prossimo_tentativo) > currentTime) {
        summary.saltati++;
        logger.info('[PIXEL TERRITORIALE] non ancora dovuto', { comune });
        continue;
      }
      const started = Date.now();
      let result, stato = 'errore', ultimoErrore = null;
      try {
        result = await diagnostic(comune);
        stato = ['ok','parziale','budget_esaurito'].includes(result.stato) ? result.stato : 'errore';
        if (stato === 'errore') ultimoErrore = `Stato diagnostico inatteso: ${String(result.stato)}`;
        if (stato === 'parziale') ultimoErrore = `Categorie fallite: ${result.errori?.length ?? 0}`;
      } catch (error) { ultimoErrore = String(error.message).slice(0, 500); }
      const durata = Math.min(2147483647, Date.now() - started);
      const nextTime = new Date(currentTime.getTime() + config.intervalMs);
      // Persistiamo SOLO conteggi, stato e tempi: nessun place_id, nome o coordinata Google.
      await client.query(`INSERT INTO public.pixel_territorial_runs
        (codice_istat_comune, ultima_esecuzione, prossimo_tentativo, stato, durata_ms,
         nodi, candidati_distinti, selezionati_comunali, errori_categorie, ultimo_errore, aggiornato_il)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
        ON CONFLICT (codice_istat_comune) DO UPDATE SET
          ultima_esecuzione=EXCLUDED.ultima_esecuzione,
          prossimo_tentativo=EXCLUDED.prossimo_tentativo,
          stato=EXCLUDED.stato, durata_ms=EXCLUDED.durata_ms,
          nodi=EXCLUDED.nodi, candidati_distinti=EXCLUDED.candidati_distinti,
          selezionati_comunali=EXCLUDED.selezionati_comunali,
          errori_categorie=EXCLUDED.errori_categorie,
          ultimo_errore=EXCLUDED.ultimo_errore, aggiornato_il=now()`,
        [comune, currentTime, nextTime, stato, durata, result?.nodi ?? null,
         result?.candidati_distinti ?? null, result?.selezionati_comunali ?? null,
         result?.errori?.length ?? null, ultimoErrore]);
      summary.scritture_audit++;
      summary.eseguiti++;
      if (stato === 'errore' || stato === 'parziale') summary.errori++;
      logger.info('[PIXEL TERRITORIALE] shadow', {
        comune, stato, nodi: result?.nodi ?? null,
        candidati_distinti: result?.candidati_distinti ?? null,
        selezionati_comunali: result?.selezionati_comunali ?? null,
        errori_categorie: result?.errori?.length ?? null, durata_ms: durata,
        scritture_fermate: 0, prossimo_tentativo: nextTime.toISOString(),
      });
    } catch (error) {
      summary.errori++;
      logger.error('[PIXEL TERRITORIALE] errore infrastrutturale', { comune, errore: error.message });
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); }
        catch (e) { logger.error('[PIXEL TERRITORIALE] errore unlock', { comune, errore: e.message }); }
      }
      client.release();
    }
  }
  return summary;
}
