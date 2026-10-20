// TURENTU POPBUS V2 — fallback formazioni A/R-safe (PURE, NO DB).
// Il piano/contesto territoriale appartiene esclusivamente a PIXEL.
// Non crea direttrici, non altera richieste, non applica prezzi o attivazioni.
// Le richieste A/R complete possono restare candidate: il vincolo all-or-none
// viene imposto solo dall'ottimizzatore globale e dal commit atomico.

const validId = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const fail = s => { throw new Error('PIXEL_AR_SAFE_FORMATIONS: ' + s); };
const sortedIds = xs => xs.map(Number).sort((a,b)=>a-b);

export function generaFormazioniArSafe({
  plan, requests, seeds = [], registro,
  generaFormazioniAlternative, valutaRichieste,
  options = {}, maxSeeds = 100, maxFormazioni = 500
} = {}) {
  if (!plan || !Array.isArray(plan.nodes) || !Array.isArray(plan.legs)) fail('piano PIXEL mancante');
  if (!Array.isArray(requests) || !Array.isArray(seeds) || !registro ||
      !Array.isArray(registro.esclusiIds) || !Array.isArray(registro.arPairs)) fail('input invalido');
  if (typeof generaFormazioniAlternative !== 'function' || typeof valutaRichieste !== 'function') fail('funzioni model obbligatorie');
  if (![maxSeeds,maxFormazioni].every(x=>Number.isSafeInteger(x) && x>0 && x<=5000)) fail('limiti invalidi');
  if (options.excludeIds !== undefined || options.includeIds !== undefined || options.mode !== undefined) {
    fail('excludeIds/includeIds/mode gestiti internamente: opzioni non ammesse');
  }
  const byId = new Map();
  for (const r of requests) {
    if (!validId(r?.id) || byId.has(Number(r.id))) fail('richieste duplicate o invalide');
    byId.set(Number(r.id),r);
  }
  if (seeds.some(x=>!validId(x) || !byId.has(Number(x)))) fail('seed assente o invalido');
  const excluded = new Set(registro.esclusiIds.map(Number));
  if ([...excluded].some(x=>!validId(x))) fail('esclusioni invalide');
  const pairs = new Map();
  for (const p of registro.arPairs) {
    if (!validId(p?.andata) || !validId(p?.ritorno) || Number(p.andata)===Number(p.ritorno)) fail('coppia A/R invalida');
    for (const id of [Number(p.andata),Number(p.ritorno)]) {
      if (!byId.has(id) || pairs.has(id) || excluded.has(id)) fail('coppia A/R incoerente con opportunita');
      pairs.set(id,p);
    }
  }
  // Fail-closed: nessuna richiesta A/R non verificata può entrare nelle formazioni.
  for (const r of requests) {
    const id=Number(r.id);
    if (r.ar_vincolata === true && !excluded.has(id) && !pairs.has(id)) fail('A/R non registrata: '+id);
    if (r.ar_vincolata !== true && r.ar_vincolata !== false) fail('flag A/R non booleano: '+id);
  }
  const eligible = requests.filter(r=>!excluded.has(Number(r.id)));
  if (!eligible.length) return {formazioni:[],diagnostica:{esclusiIds:sortedIds([...excluded]),seedOriginali:sortedIds(seeds),fallback:false}};
  const originalSeeds = sortedIds([...new Set(seeds.map(Number).filter(id=>!excluded.has(id)))]);
  const ordinarySeeds = eligible.filter(r=>r.ar_vincolata===false).map(r=>Number(r.id));
  const seedVariants = new Map();
  const addSeeds = ids => {
    const unique=sortedIds([...new Set(ids)]);
    if (!unique.length) return;
    const k=unique.join(',');
    if (!seedVariants.has(k)) {
      if (seedVariants.size>=maxSeeds) fail('limite maxSeeds raggiunto: nessun troncamento');
      seedVariants.set(k,unique);
    }
  };
  // Conserva i seed PIXEL originari quando ancora ammissibili.
  if (originalSeeds.length) addSeeds(originalSeeds);
  // Fallback ordinario anche se il seed PIXEL originale era A/R.
  for (const id of ordinarySeeds) addSeeds([id]);
  // La selezione di formazioni non implica che una singola tratta A/R
  // sia attivabile: l'ottimizzatore imporrà entrambe globalmente.
  const alternatives = new Map();
  const addEvaluation = e => {
    if (!e || !Array.isArray(e.requests) || !e.requests.length) return;
    const ids=e.requests.map(r=>Number(r.id));
    if (ids.some(id=>!byId.has(id) || excluded.has(id))) fail('model ha restituito richiesta esclusa');
    const key=sortedIds(ids).join(',');
    if (!alternatives.has(key)) {
      if (alternatives.size>=maxFormazioni) fail('limite maxFormazioni raggiunto: nessun troncamento');
      alternatives.set(key,e);
    }
  };
  for (const seedSet of seedVariants.values()) {
    // Il modello può avere un limite interno: non assumiamo completezza combinatoria.
    const evaluations=generaFormazioniAlternative(plan,eligible,seedSet,{...options,maxFormazioni:Math.min(500,maxFormazioni)});
    if (!Array.isArray(evaluations)) fail('model ha restituito risultato invalido');
    for (const e of evaluations) addEvaluation(e);
    // Forza rivalutazione completa dell'alternativa ordinaria per ogni seed,
    // senza mantenere ricavi/occupazione della formazione mista.
    if (seedSet.length===1 && !pairs.has(seedSet[0])) {
      const ordinarie=eligible.filter(r=>r.ar_vincolata===false);
      addEvaluation(valutaRichieste(plan,ordinarie,seedSet,{...options,mode:'greedy'}));
    }
  }
  return {
    formazioni:[...alternatives.values()],
    diagnostica:{esclusiIds:sortedIds([...excluded]),seedOriginali:sortedIds(seeds),
      seedValutati:[...seedVariants.values()],fallback:ordinarySeeds.length>0,
      formazioni:alternatives.size,
      nota:'Nessuna garanzia di enumerazione esaustiva; attivazione A/R vietata senza ottimizzatore globale'}
  };
}
