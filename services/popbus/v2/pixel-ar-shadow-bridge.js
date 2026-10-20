// TURENTU — PIXEL -> POPBUS A/R shadow bridge (NO WRITES).
// Input: contesti PIXEL originali + proposte CICLO gia' rivalutate e prezzate.
// Il chiamante gestisce REPEATABLE READ READ ONLY, e NON puo' usare l'output per il commit.
const validId = x => Number.isSafeInteger(Number(x)) && Number(x)>0;
const fail = s => { throw new Error('PIXEL_AR_SHADOW: '+s); };
const idsOf = c => {
  const raw=c?.richieste ?? c?.evaluation?.requests;
  if (!Array.isArray(raw) || !raw.length) fail('candidata senza richieste');
  const ids=raw.flat(Infinity).map(r=>Number(typeof r==='object' && r!==null?r.id:r));
  if (ids.some(id=>!validId(id)) || new Set(ids).size!==ids.length) fail('ID candidata invalidi o duplicati');
  return ids;
};
export async function eseguiPixelArShadow({client,contesti,proposte,leggiRegistroAr,filtraCandidateAr,ottimizzaFlotta,maxCandidati=500,maxNodi=100000}={}) {
  if (!client?.query || !Array.isArray(contesti) || !Array.isArray(proposte) ||
      typeof leggiRegistroAr!=='function' || typeof filtraCandidateAr!=='function' || typeof ottimizzaFlotta!=='function') fail('input invalido');
  if (![maxCandidati,maxNodi].every(x=>Number.isSafeInteger(x)&&x>0)) fail('limiti invalidi');
  const opportunityIds=new Set(), allIds=new Set(), byId=new Map();
  for (const ctx of contesti) {
    if (!validId(ctx?.pixel_opportunita_id) || !validId(ctx?.pixel_direttrice_id) || !validId(ctx?.versione) ||
        !Array.isArray(ctx.richiesta_ids) || !Array.isArray(ctx.requests) || !ctx.plan || !ctx.window) fail('contesto PIXEL invalido');
    const key=String(ctx.pixel_opportunita_id);
    if (opportunityIds.has(key)) fail('opportunita PIXEL duplicata');
    opportunityIds.add(key);
    const allowed=new Set(ctx.richiesta_ids.map(Number));
    if (allowed.size!==ctx.richiesta_ids.length || [...allowed].some(x=>!validId(x))) fail('ID opportunita invalidi');
    const rows=new Map(ctx.requests.map(r=>[Number(r.id),r]));
    if (rows.size!==ctx.requests.length || rows.size!==allowed.size || [...allowed].some(id=>!rows.has(id))) fail('richieste contesto incomplete');
    for (const id of allowed) {
      const r=rows.get(id);
      if (r.stato!=='in_attesa' || r.corsa_id!=null) fail('richiesta PIXEL non disponibile');
      if (byId.has(id)) {
        const prev=byId.get(id);
        if (prev.ar_group_id!==r.ar_group_id || prev.ar_tratta!==r.ar_tratta || prev.ar_vincolata!==r.ar_vincolata) fail('metadata richiesta incoerenti fra opportunita');
      }
      byId.set(id,r); allIds.add(id);
    }
  }
  // Lettura registro sulla STESSA snapshot dei contesti PIXEL.
  const registro=await leggiRegistroAr({client,richiestaIds:[...allIds]});
  const knownPairs=new Map();
  for (const pair of registro.arPairs) for (const id of [pair.andata,pair.ritorno]) {
    if (!allIds.has(Number(id)) || knownPairs.has(Number(id))) fail('registro coppie incoerente');
    knownPairs.set(Number(id),pair);
  }
  const excluded=new Set(registro.esclusiIds.map(Number));
  for (const [id,r] of byId) {
    if (r.ar_vincolata===true && !knownPairs.has(id) && !excluded.has(id)) fail('richiesta A/R non registrata');
    if (r.ar_vincolata!==true && r.ar_vincolata!==false) fail('flag A/R invalido');
  }
  for (const c of proposte) {
    const ids=idsOf(c);
    if (!Array.isArray(c._pixelOpportunitaIds) || !c._pixelOpportunitaIds.length ||
        c._pixelOpportunitaIds.some(id=>!opportunityIds.has(String(id)))) fail('provenienza PIXEL non verificabile');
    const allowed=new Set(contesti.filter(ctx=>c._pixelOpportunitaIds.map(String).includes(String(ctx.pixel_opportunita_id)))
      .flatMap(ctx=>ctx.richiesta_ids.map(Number)));
    if (ids.some(id=>!allIds.has(id) || !allowed.has(id))) fail('candidata contiene richiesta fuori opportunita');
    if (!Number.isFinite(Number(c.margine_ciclo_con_attesa_euro)) || c._economiaRicalcolata!==true)
      fail('economia ciclo non certificata dal chiamante');
  }
  const ammissibili=filtraCandidateAr(proposte,registro);
  if (ammissibili.length>maxCandidati) fail('limite candidati senza troncamento');
  const scelta=ottimizzaFlotta(ammissibili,{arPairs:registro.arPairs,maxCandidati,maxNodi});
  const chosen=new Set(scelta.richiesteIds||[]);
  for (const pair of registro.arPairs) if (chosen.has(pair.andata)!==chosen.has(pair.ritorno)) fail('ottimizzatore ha violato vincolo A/R');
  return {registro,scelta,diagnostica:{opportunita:contesti.length,richieste:allIds.size,proposte:proposte.length,
    proposteAmmissibili:ammissibili.length,proposteEscluse:proposte.length-ammissibili.length,
    coppieAr:registro.arPairs.length,shadow:true,dbWrites:0,
    nota:'Nessun commit; economia, routing, capienza e disponibilita devono essere validate prima dal worker e al commit'}};
}
