// PIXEL V5.7 — trasformazione read-only di un piano territoriale in metriche.
// Nessuna connessione DB, chiamata HTTP, persistenza o attivazione.
const CODE = /^\d{6}$/;
const CATEGORIES = new Set(['trasporto', 'autobus', 'ferrovia', 'porto', 'aeroporto', 'stadio']);

export function summarizePixelV57Plan(codiceIstat, plan, maxCalls = 48) {
  const comune = String(codiceIstat);
  if (!CODE.test(comune)) throw new Error('Codice ISTAT non valido');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 500)
    throw new Error('Budget chiamate non valido');
  if (!plan || plan.modalita !== 'DRY_RUN' || !Array.isArray(plan.piano))
    throw new Error('Piano V5.6.1 DRY_RUN non valido');
  if (String(plan.comune) !== comune) throw new Error('Comune del piano non coerente');
  if (plan.piano.length > maxCalls) throw new Error('Budget del piano superato');
  if (plan.centri_fuori_comune !== 0) throw new Error('Piano con centri fuori comune');
  if (plan.diagnostica?.nessuna_chiamata_google !== true || plan.diagnostica?.nessuna_scrittura !== true)
    throw new Error('Piano non dichiarato privo di chiamate e scritture');
  const pairs = new Set();
  const categories = {};
  const centers = new Set();
  for (const call of plan.piano) {
    if (!call || !CATEGORIES.has(call.categoria) || typeof call.centro_id !== 'string')
      throw new Error('Chiamata pianificata non valida');
    if (!Number.isFinite(call.lat) || !Number.isFinite(call.lon) ||
        call.lat < -90 || call.lat > 90 || call.lon < -180 || call.lon > 180)
      throw new Error('Coordinate pianificate non valide');
    const pair = `${call.centro_id}:${call.categoria}`;
    if (pairs.has(pair)) throw new Error('Coppia centro/categoria duplicata');
    pairs.add(pair);
    centers.add(call.centro_id);
    categories[call.categoria] = (categories[call.categoria] ?? 0) + 1;
  }
  const coverage = Number(plan.copertura_geometrica_piano_pct);
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 100)
    throw new Error('Copertura geometrica non valida');
  return {
    comune, stato: 'piano_pronto', modalita: 'PLAN',
    centri_esplorati: centers.size,
    chiamate_pianificate: plan.piano.length,
    max_chiamate: maxCalls,
    copertura_geometrica_pct: coverage,
    categorie: categories,
    scritture_fermate: 0, scritture_audit: 0,
    nota: 'Simulazione di pianificazione: nessuna discovery eseguita, nessuna fermata censita o ammessa.'
  };
}

export async function runPixelV57PlanCycle(config, {
  database, planner, logger = console,
} = {}) {
  if (config?.mode !== 'PLAN') throw new Error('Modalita PLAN richiesta');
  if (!database || typeof database.query !== 'function' || typeof planner !== 'function')
    throw new Error('Dipendenze PLAN mancanti');
  const maxCalls = config.maxGoogleCalls ?? 48;
  const comuni = config.auto
    ? (await database.query('SELECT codice_istat_comune FROM public.pixel_budget_comunali ORDER BY codice_istat_comune LIMIT $1', [1001])).rows.map(r => String(r.codice_istat_comune))
    : config.comuni;
  if (!Array.isArray(comuni) || comuni.length > 1000) throw new Error('Troppi comuni');
  const summary = { mode: 'PLAN', eseguiti: 0, saltati: 0, errori: 0,
    scritture_fermate: 0, scritture_audit: 0, risultati: [] };
  for (const comune of comuni) {
    try {
      const plan = await planner(comune, { database, maxGoogleCalls: maxCalls, categoryQuotas: config.categoryQuotas ?? { autobus: 2, ferrovia: 1, porto: 1 } });
      const result = summarizePixelV57Plan(comune, plan, maxCalls);
      summary.risultati.push(result);
      summary.eseguiti++;
      logger.info('[PIXEL V5.7 PLAN]', result);
    } catch (error) {
      summary.errori++;
      summary.risultati.push({ comune, stato: 'errore', errore: String(error.message).slice(0, 250) });
      logger.error('[PIXEL V5.7 PLAN] errore', { comune, errore: error.message });
    }
  }
  return summary;
}
