// TURENTU POPBUS V2 — Comparatore strategie fisiche SHADOW.
// Nessun DB, scrittura, offerta o attivazione. Le callback sono fornite dal chiamante.
import { valutaEconomiaCiclo } from './cycle-pricing.js';

const fail = s => { throw new Error(`POPBUS_STRATEGY_SHADOW: ${s}`); };
const finite = n => n !== null && n !== undefined && Number.isFinite(Number(n));
const positive = n => Number.isSafeInteger(Number(n)) && Number(n) > 0;
const point = p => p && finite(p.lat) && finite(p.lon);
const key = p => `${Number(p.lat)},${Number(p.lon)}`;
const ids = m => m.requests.map(r => Number(r.id));
const overlap = (a,b) => { const s=new Set(ids(a)); return ids(b).some(id=>s.has(id)); };
const euro = n => Math.round(n*100)/100;

function validateCandidate(m) {
  if (!m || m.tipoItinerario !== 'FERMATE_FISICHE' || m.schemaVersion !== 2 ||
      !positive(m.vehicleId) || !positive(m.pixelOpportunitaId) ||
      !point(m.from) || !point(m.to) || !finite(m.departure) || !finite(m.arrival) ||
      Number(m.arrival) <= Number(m.departure) || !finite(m.kmMissione) ||
      Number(m.kmMissione) < 0 || !finite(m.peak) || Number(m.peak)<0 ||
      !Array.isArray(m.requests) || !m.requests.length ||
      !Array.isArray(m.plan?.nodes) || m.plan.nodes.length<2 ||
      !Array.isArray(m.plan?.legs) || m.plan.legs.length!==m.plan.nodes.length-1 ||
      !Array.isArray(m.nodiFisici) || !Array.isArray(m.evaluation?.requests)) fail('candidato fisico incompleto');
  const requestIds=ids(m);
  if (!requestIds.every(positive) || new Set(requestIds).size!==requestIds.length ||
      m.requests.some(r=>!finite(r.prezzo)||Number(r.prezzo)<0) ||
      m.plan.nodes.some(n=>!positive(n)) ||
      m.plan.legs.some(l=>!finite(l.metres)||Number(l.metres)<0||!finite(l.seconds)||Number(l.seconds)<0)) fail('richieste/segmenti invalidi');
  const stops=new Map(m.nodiFisici.map(s=>[Number(s.id),s]));
  if (m.nodiFisici.some(s=>!positive(s.id)||!point(s)) ||
      m.plan.nodes.some(n=>!stops.has(Number(n))) ||
      key(stops.get(Number(m.plan.nodes[0])))!==key(m.from) ||
      key(stops.get(Number(m.plan.nodes.at(-1))))!==key(m.to)) fail('fermate fisiche incoerenti');
  if (m.evaluation.requests.length!==requestIds.length ||
      new Set(m.evaluation.requests.map(r=>Number(r.id))).size!==requestIds.length ||
      m.evaluation.requests.some(r=>!requestIds.includes(Number(r.id)) ||
        !Number.isSafeInteger(Number(r.start)) || !Number.isSafeInteger(Number(r.end)) ||
        Number(r.start)<0 || Number(r.end)<=Number(r.start) ||
        Number(r.end)>=m.plan.nodes.length)) fail('valutazione richieste incoerente');
}

function normalizeVehicles(vehicles) {
  const map=new Map();
  for(const v of vehicles){
    const rate=v.euro_km ?? v.euroKm;
    if(!positive(v.id)||!point(v)||!finite(rate)||Number(rate)<0||!positive(v.posti_totali)) fail('veicolo invalido');
    const item={...v,id:Number(v.id),lat:Number(v.lat),lon:Number(v.lon),euroKm:Number(rate),posti_totali:Number(v.posti_totali)};
    const prev=map.get(item.id);
    if(prev && (key(prev)!==key(item)||prev.euroKm!==item.euroKm||prev.posti_totali!==item.posti_totali)) fail('veicolo duplicato divergente');
    map.set(item.id,item);
  }
  return map;
}

const summary = s => ({vehicleIds:s.vehicleIds,opportunitaIds:s.opportunitaIds,
  richiestaIds:s.richiestaIds,numeroRichieste:s.richiestaIds.length,
  kmTotali:s.kmTotali,ricavoLordoEuro:s.ricavoLordoEuro,
  ricavoNettoEuro:s.ricavoNettoEuro,remunerazioneNccEuro:s.remunerazioneNccEuro,
  margineEuro:s.margineEuro,deficitLordoEuro:s.deficitLordoEuro,
  economicamenteAmmissibile:s.economicamenteAmmissibile,attivabile:false});
const rank=(a,b)=>b.richiestaIds.length-a.richiestaIds.length ||
  b.margineEuro-a.margineEuro || a.kmTotali-b.kmTotali ||
  a.vehicleIds.join(',').localeCompare(b.vehicleIds.join(','));

/**
 * validateSelection(requestIds,missions) deve certificare A/R globale e vincoli
 * di classe/qualita non gia' verificati dai candidati fisici.
 * La selezione multimissione deve provenire da selezionaCicliFisiciShadow.
 * Un risultato di quel selettore contiene solo cicli economicamente ammissibili.
 */
export async function confrontaStrategieFisicheShadow({
  candidati,vehicles,movement,isAvailable,hasConflicts,validateSelection,
  selezioneFisica,now=Date.now(),maxRoutingCalls=500,
  maxIndependentPairs=2000000,costoAttesaOraEuro=0,
  altriCostiEuro=0,margineMinimoEuro=0
}={}) {
  if(!Array.isArray(candidati)||!Array.isArray(vehicles)||
     typeof movement!=='function'||typeof isAvailable!=='function'||
     typeof hasConflicts!=='function'||typeof validateSelection!=='function') fail('dipendenze obbligatorie mancanti');
  if(!positive(maxRoutingCalls)||!positive(maxIndependentPairs)||!finite(now)||
     [costoAttesaOraEuro,altriCostiEuro,margineMinimoEuro].some(x=>!finite(x)||Number(x)<0)) fail('parametri invalidi');
  if(!selezioneFisica || selezioneFisica.shadow!==true ||
     selezioneFisica.attivabile!==false || selezioneFisica.dbWrites!==0 ||
     selezioneFisica.diagnostica?.completo!==true ||
     !Array.isArray(selezioneFisica.miglioriCicli)) fail('selezione cicli SHADOW completa obbligatoria');
  const vmap=normalizeVehicles(vehicles);
  const routes=new Map(); let routingCalls=0;
  const availabilityCache=new Map(), conflictCache=new Map();
  let availabilityCalls=0, conflictCalls=0, availabilityCacheHits=0, conflictCacheHits=0;
  const startedAt=performance.now();
  let physicalDoneAt=startedAt, singlesDoneAt=startedAt, pairsDoneAt=startedAt;
  async function cachedCheck(cache, callback, v, start, end, kind) {
    // Cache per identico veicolo/intervallo, valida solo nello snapshot READ ONLY.
    const k=`${v.id}|${start}|${end}`;
    if(cache.has(k)) {
      if(kind==='availability') availabilityCacheHits++; else conflictCacheHits++;
      return cache.get(k);
    }
    if(kind==='availability') availabilityCalls++; else conflictCalls++;
    const value=await callback(v,start,end);
    if(typeof value!=='boolean') fail(`${kind}: callback non booleana`);
    cache.set(k,value);
    return value;
  }
  const economicDiagnostics={
    singoleAnalizzate:0,singoleEconomicamenteAmmissibili:0,
    singoleEconomicamenteInsufficienti:0,deficitMinimoEuro:null,
    margineMiglioreEuro:null,perVeicolo:[],esempiMigliori:[]
  };
  const vehicleEconomics=new Map();
  function recordSingle(x) {
    const e=x.economy, v=x.v, m=x.m;
    const deficit=Math.max(0,Math.round((e.sogliaAttivazioneLordaEuro-e.ricavoLordoEuro)*100)/100);
    const emptyKm=e.km.avvicinamento+e.km.ritornoBase;
    const sample={vehicleId:v.id,opportunitaId:Number(m.pixelOpportunitaId),
      richiestaIds:ids(m),ricavoLordoEuro:e.ricavoLordoEuro,
      ricavoNettoEuro:e.ricavoNettoEuro,remunerazioneNccEuro:e.costoCompletoEuro,
      margineEuro:e.margineEuro,deficitLordoEuro:deficit,
      sogliaAttivazioneLordaEuro:e.sogliaAttivazioneLordaEuro,
      kmTotali:e.km.totali,kmAvvicinamento:e.km.avvicinamento,
      kmMissione:e.km.missioni,kmRitornoBase:e.km.ritornoBase,
      kmVuoto:Math.round(emptyKm*1000)/1000,
      quotaKmVuotoPercento:e.km.totali>0?Math.round(emptyKm/e.km.totali*10000)/100:null,
      economicamenteAmmissibile:e.economicamenteAttivabile};
    economicDiagnostics.singoleAnalizzate++;
    if(e.economicamenteAttivabile) economicDiagnostics.singoleEconomicamenteAmmissibili++;
    else economicDiagnostics.singoleEconomicamenteInsufficienti++;
    economicDiagnostics.deficitMinimoEuro=economicDiagnostics.deficitMinimoEuro===null?deficit:Math.min(economicDiagnostics.deficitMinimoEuro,deficit);
    economicDiagnostics.margineMiglioreEuro=economicDiagnostics.margineMiglioreEuro===null?e.margineEuro:Math.max(economicDiagnostics.margineMiglioreEuro,e.margineEuro);
    const entry=vehicleEconomics.get(v.id)??{vehicleId:v.id,candidati:0,ammissibili:0,
      deficitMinimoEuro:null,margineMiglioreEuro:null,miglioreAlternativa:null};
    entry.candidati++;
    if(e.economicamenteAttivabile) entry.ammissibili++;
    entry.deficitMinimoEuro=entry.deficitMinimoEuro===null?deficit:Math.min(entry.deficitMinimoEuro,deficit);
    entry.margineMiglioreEuro=entry.margineMiglioreEuro===null?e.margineEuro:Math.max(entry.margineMiglioreEuro,e.margineEuro);
    if(!entry.miglioreAlternativa||deficit<entry.miglioreAlternativa.deficitLordoEuro||
       (deficit===entry.miglioreAlternativa.deficitLordoEuro&&e.margineEuro>entry.miglioreAlternativa.margineEuro)) entry.miglioreAlternativa=sample;
    vehicleEconomics.set(v.id,entry);
    economicDiagnostics.esempiMigliori.push(sample);
    economicDiagnostics.esempiMigliori.sort((a,b)=>a.deficitLordoEuro-b.deficitLordoEuro||b.margineEuro-a.margineEuro||a.vehicleId-b.vehicleId);
    if(economicDiagnostics.esempiMigliori.length>10) economicDiagnostics.esempiMigliori.length=10;
  }
  async function route(from,to){
    const k=`${key(from)}>${key(to)}`;
    if(routes.has(k)) return routes.get(k);
    if(routingCalls>=maxRoutingCalls) fail('budget routing superato, nessun risultato parziale');
    routingCalls++;
    const r=await movement(from,to);
    if(!r||!finite(r.metres)||!finite(r.seconds)||Number(r.metres)<0||Number(r.seconds)<0) fail('routing non valido');
    const result={metres:Number(r.metres),seconds:Number(r.seconds)};
    routes.set(k,result);return result;
  }
  const diagnostic={candidati:candidati.length,candidatiOperativamenteFattibili:0,
    singoleAmmissibili:0,coppieIndipendentiEsaminate:0,
    coppieIndipendentiAmmissibili:0,scartiRichiesteComuni:0,
    scartiVincoliGlobali:0,scartiEconomia:0,scartiOperativi:0,
    chiamateRouting:0,rotteInCache:0,completo:true};
  const operational=[];
  for(const m of candidati){
    validateCandidate(m);
    const v=vmap.get(Number(m.vehicleId));
    if(!v||Number(m.peak)>v.posti_totali) fail('veicolo assente o capienza incoerente');
    const approach=await route(v,m.from),ret=await route(m.to,v);
    const busyStart=Number(m.departure)-approach.seconds*1000;
    const busyEnd=Number(m.arrival)+ret.seconds*1000;
    if(busyStart<=Number(now)||
       !(await cachedCheck(availabilityCache,isAvailable,v,busyStart,busyEnd,'availability'))||
       (await cachedCheck(conflictCache,hasConflicts,v,busyStart,busyEnd,'conflicts'))){diagnostic.scartiOperativi++;continue;}
    const economy=valutaEconomiaCiclo({
      ricaviRichiesteEuro:m.requests.map(r=>Number(r.prezzo)),
      kmAvvicinamento:approach.metres/1000,kmMissioni:Number(m.kmMissione),
      kmTrasferimenti:0,kmRitornoBase:ret.metres/1000,euroKm:v.euroKm,
      costoAttesaOraEuro,altriCostiEuro,margineMinimoEuro
    });
    const item={m,v,busyStart,busyEnd,economy};
    operational.push(item);
    recordSingle(item);
  }
  physicalDoneAt=performance.now();
  diagnostic.candidatiOperativamenteFattibili=operational.length;
  economicDiagnostics.perVeicolo=[...vehicleEconomics.values()].sort((a,b)=>a.vehicleId-b.vehicleId);
  const validSingles=[];
  for(const x of operational){
    // Nessuna singola puo' essere attivata se il ciclo completo non copre il compenso NCC.
    if(!x.economy.economicamenteAttivabile){diagnostic.scartiEconomia++;continue;}
    if(await validateSelection(ids(x.m),[x.m])!==true){diagnostic.scartiVincoliGlobali++;continue;}
    diagnostic.singoleAmmissibili++;
    validSingles.push({vehicleIds:[x.v.id],opportunitaIds:[Number(x.m.pixelOpportunitaId)],
      richiestaIds:ids(x.m),kmTotali:x.economy.km.totali,
      ricavoLordoEuro:x.economy.ricavoLordoEuro,
      ricavoNettoEuro:x.economy.ricavoNettoEuro,
      remunerazioneNccEuro:x.economy.costoCompletoEuro,
      margineEuro:x.economy.margineEuro,
      deficitLordoEuro:Math.max(0,euro(x.economy.sogliaAttivazioneLordaEuro-x.economy.ricavoLordoEuro)),
      economicamenteAmmissibile:true});
  }
  validSingles.sort(rank);
  singlesDoneAt=performance.now();
  // Coppie indipendenti: veicoli diversi e nessuna richiesta in comune.
  // Non si richiede la validita' A/R delle singole missioni: solo dell'insieme.
  // Filtro economico anticipato SOLO per le coppie indipendenti.
  // I cicli concatenati restano invariati: possono compensare missioni singole in perdita.
  // Non filtrare tramite validSingles: i vincoli globali A/R si verificano sulla coppia.
  const operationalEconomic=operational.filter(x=>x.economy.economicamenteAttivabile===true);
  diagnostic.candidatiEconomiciPerCoppie=operationalEconomic.length;
  diagnostic.candidatiEsclusiPerEconomiaPrimaDelleCoppie=operational.length-operationalEconomic.length;
  let bestIndependent=null;
  for(let i=0;i<operationalEconomic.length;i++) for(let j=i+1;j<operationalEconomic.length;j++){
    const a=operationalEconomic[i],b=operationalEconomic[j];
    if(a.v.id===b.v.id || Number(a.m.pixelOpportunitaId)===Number(b.m.pixelOpportunitaId)) continue;
    diagnostic.coppieIndipendentiEsaminate++;
    if(diagnostic.coppieIndipendentiEsaminate>maxIndependentPairs) fail('budget coppie indipendenti superato, nessun risultato parziale');
    if(overlap(a.m,b.m)){diagnostic.scartiRichiesteComuni++;continue;}
    const requestIds=[...ids(a.m),...ids(b.m)];
    if(await validateSelection(requestIds,[a.m,b.m])!==true){diagnostic.scartiVincoliGlobali++;continue;}
    diagnostic.coppieIndipendentiAmmissibili++;
    const candidate={vehicleIds:[a.v.id,b.v.id].sort((x,y)=>x-y),
      opportunitaIds:[Number(a.m.pixelOpportunitaId),Number(b.m.pixelOpportunitaId)],
      richiestaIds:requestIds,kmTotali:a.economy.km.totali+b.economy.km.totali,
      ricavoLordoEuro:euro(a.economy.ricavoLordoEuro+b.economy.ricavoLordoEuro),
      ricavoNettoEuro:euro(a.economy.ricavoNettoEuro+b.economy.ricavoNettoEuro),
      remunerazioneNccEuro:euro(a.economy.costoCompletoEuro+b.economy.costoCompletoEuro),
      margineEuro:euro(a.economy.margineEuro+b.economy.margineEuro),
      deficitLordoEuro:0,economicamenteAmmissibile:true};
    if(!bestIndependent||rank(candidate,bestIndependent)<0) bestIndependent=candidate;
  }
  pairsDoneAt=performance.now();
  // Il selettore di cicli gia' certifica routing, turni e conflitti dell'intero ciclo.
  // NON usiamo solo miglioriCicli per affermare un ottimo globale: sono TOP-K
  // ordinati dal selettore, non un insieme esaustivo di cicli ammissibili.
  const multi=selezioneFisica.miglioriCicli.map(c=>{
    if(c.attivabile!==false||!c.economia?.economicamenteAttivabile||
       !Array.isArray(c.missioni)||c.missioni.length!==2) fail('ciclo multimissione non certificato');
    return {vehicleIds:[Number(c.vehicleId)],
      opportunitaIds:c.missioni.map(m=>Number(m.pixelOpportunitaId)),
      richiestaIds:c.richiestaIds.map(Number),kmTotali:c.economia.km.totali,
      ricavoLordoEuro:c.economia.ricavoLordoEuro,
      ricavoNettoEuro:c.economia.ricavoNettoEuro,
      remunerazioneNccEuro:c.economia.costoCompletoEuro,
      margineEuro:c.economia.margineEuro,deficitLordoEuro:0,
      economicamenteAmmissibile:true};
  }).sort(rank);
  const options=[...validSingles.slice(0,1),...(bestIndependent?[bestIndependent]:[]),...multi.slice(0,1)];
  options.sort(rank);
  diagnostic.chiamateRouting=routingCalls;
  diagnostic.rotteInCache=routes.size;
  diagnostic.chiamateDisponibilita=availabilityCalls;
  diagnostic.cacheHitsDisponibilita=availabilityCacheHits;
  diagnostic.chiamateConflitti=conflictCalls;
  diagnostic.cacheHitsConflitti=conflictCacheHits;
  // Le coppie economicamente escluse non vengono piu enumerate.
  // Non confondere questa metrica con gli scarti economici delle singole.
  diagnostic.coppieEsclusePerEconomiaSenzaValidazione=null;
  diagnostic.filtroEconomicoAnticipatoCoppie=true;
  diagnostic.tempiMs={singoleOperative:Math.round(physicalDoneAt-startedAt),
    validazioneSingole:Math.round(singlesDoneAt-physicalDoneAt),
    confrontoCoppie:Math.round(pairsDoneAt-singlesDoneAt),
    totale:Math.round(performance.now()-startedAt)};
  return {shadow:true,attivabile:false,dbWrites:0,offerte:0,
    diagnostica:diagnostic,
    diagnosticaEconomicaSingole:economicDiagnostics,
    miglioreSingola:validSingles[0]?summary(validSingles[0]):null,
    miglioreCoppiaIndipendente:bestIndependent?summary(bestIndependent):null,
    miglioreConcatenata:multi[0]?summary(multi[0]):null,
    miglioreTraStrategieEsaminate:options[0]?summary(options[0]):null,
    nota:'Confronto diagnostico: il ranking usa richieste e margine, non certifica ottimo globale di flotta o qualita comparativa. I cicli concatenati provengono dal TOP-K del selettore.'};
}
