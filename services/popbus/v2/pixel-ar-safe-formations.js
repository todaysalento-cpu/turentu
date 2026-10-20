// TURENTU POPBUS V2 - formazioni A/R-safe (PURE, NO DB).
// PIXEL resta l'unico proprietario delle direttrici e delle opportunita.
// Le coppie A/R possono attraversare opportunita PIXEL distinte;
// il vincolo di selezione congiunta e' applicato dall'ottimizzatore globale.

const validId = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const fail = s => { throw new Error('PIXEL_AR_SAFE_FORMATIONS: ' + s); };
const sortedIds = xs => xs.map(Number).sort((a,b) => a-b);

export function generaFormazioniArSafe({
  plan, requests, seeds = [], registro,
  generaFormazioniAlternative, valutaRichieste,
  options = {}, maxSeeds = 100, maxFormazioni = 500
} = {}) {
  if (!plan || !Array.isArray(plan.nodes) || !Array.isArray(plan.legs)) fail('piano PIXEL mancante');
  if (!Array.isArray(requests) || !Array.isArray(seeds) || !registro ||
      !Array.isArray(registro.esclusiIds) || !Array.isArray(registro.arPairs)) fail('input invalido');
  if (typeof generaFormazioniAlternative !== 'function' || typeof valutaRichieste !== 'function') fail('funzioni model obbligatorie');
  if (![maxSeeds,maxFormazioni].every(x => Number.isSafeInteger(x) && x > 0 && x <= 5000)) fail('limiti invalidi');
  if (options.excludeIds !== undefined || options.includeIds !== undefined || options.mode !== undefined) {
    fail('excludeIds/includeIds/mode gestiti internamente: opzioni non ammesse');
  }
  const byId = new Map();
  for (const r of requests) {
    if (!validId(r?.id) || byId.has(Number(r.id))) fail('richieste duplicate o invalide');
    byId.set(Number(r.id), r);
  }
  if (seeds.some(x => !validId(x) || !byId.has(Number(x)))) fail('seed assente o invalido');
  const excluded = new Set(registro.esclusiIds.map(Number));
  if ([...excluded].some(x => !validId(x))) fail('esclusioni invalide');

  // Il registro e' globale: una controparte puo' essere assente dal contesto locale.
  const partners = new Map();
  for (const p of registro.arPairs) {
    if (!validId(p?.andata) || !validId(p?.ritorno) || Number(p.andata) === Number(p.ritorno)) fail('coppia A/R invalida');
    const a = Number(p.andata), b = Number(p.ritorno);
    if (partners.has(a) || partners.has(b) || excluded.has(a) || excluded.has(b)) fail('coppia A/R incoerente nel registro');
    partners.set(a, { partner: b, tratta: 'andata' });
    partners.set(b, { partner: a, tratta: 'ritorno' });
  }
  for (const r of requests) {
    const id = Number(r.id);
    if (r.ar_vincolata !== true && r.ar_vincolata !== false) fail('flag A/R non booleano: ' + id);
    if (r.ar_vincolata === true && !excluded.has(id)) {
      const pair = partners.get(id);
      if (!pair) fail('A/R non registrata: ' + id);
      if (r.ar_tratta !== pair.tratta) fail('tratta A/R incoerente: ' + id);
    }
    if (r.ar_vincolata === false && partners.has(id)) fail('richiesta ordinaria presente in coppia A/R: ' + id);
  }

  const eligible = requests.filter(r => !excluded.has(Number(r.id)));
  if (!eligible.length) return { formazioni: [], diagnostica: {
    esclusiIds: sortedIds([...excluded]), seedOriginali: sortedIds(seeds), fallback: false
  }};

  const originalSeeds = sortedIds([...new Set(seeds.map(Number).filter(id => !excluded.has(id)))]);
  const ordinaryIds = eligible.filter(r => r.ar_vincolata === false).map(r => Number(r.id));
  const arLocalIds = eligible.filter(r => r.ar_vincolata === true).map(r => Number(r.id));
  const seedVariants = new Map();
  const addSeeds = ids => {
    const unique = sortedIds([...new Set(ids)]);
    if (!unique.length) return;
    const key = unique.join(',');
    if (!seedVariants.has(key)) {
      if (seedVariants.size >= maxSeeds) fail('limite maxSeeds raggiunto: nessun troncamento');
      seedVariants.set(key, unique);
    }
  };
  if (originalSeeds.length) addSeeds(originalSeeds);
  for (const id of ordinaryIds) addSeeds([id]);

  const alternatives = new Map();
  const addEvaluation = e => {
    if (!e || !Array.isArray(e.requests) || !e.requests.length) return;
    const ids = e.requests.map(r => Number(r.id));
    if (ids.some(id => !validId(id) || !byId.has(id) || excluded.has(id)) || new Set(ids).size !== ids.length) {
      fail('model ha restituito richieste invalide o escluse');
    }
    const key = sortedIds(ids).join(',');
    if (!alternatives.has(key)) {
      if (alternatives.size >= maxFormazioni) fail('limite maxFormazioni raggiunto: nessun troncamento');
      alternatives.set(key, e);
    }
  };
  for (const seedSet of seedVariants.values()) {
    const evaluations = generaFormazioniAlternative(plan, eligible, seedSet, {
      ...options, maxFormazioni: Math.min(500, maxFormazioni)
    });
    if (!Array.isArray(evaluations)) fail('model ha restituito risultato invalido');
    for (const e of evaluations) addEvaluation(e);
    // Fallback ordinario reale: esclude esplicitamente tutte le A/R locali.
    if (seedSet.length === 1 && !partners.has(seedSet[0])) {
      const ordinarie = eligible.filter(r => r.ar_vincolata === false);
      addEvaluation(valutaRichieste(plan, ordinarie, seedSet, {
        ...options, mode: 'greedy', excludeIds: arLocalIds
      }));
    }
  }
  return {
    formazioni: [...alternatives.values()],
    diagnostica: {
      esclusiIds: sortedIds([...excluded]), seedOriginali: sortedIds(seeds),
      seedValutati: [...seedVariants.values()], fallback: ordinaryIds.length > 0,
      formazioni: alternatives.size,
      nota: 'Nessuna enumerazione esaustiva garantita; vincolo A/R globale obbligatorio'
    }
  };
}
