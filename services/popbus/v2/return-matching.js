// TURENTU POPBUS V2 — RETURN MATCHING (motore diagnostico puro)
// Non modifica il DB e NON attiva corse. Nessuna etichetta permanente
// andata/ritorno: una richiesta resta libera per altre candidate.
// INPUT: ciclo reale cronologico (incluse connessioni e ritorno finale),
// con occorrenze di nodo anche ripetute; routing già calcolato dal planner.
// Questo modulo NON genera il percorso di ritorno, né collega da solo M1/M2.
// Il worker dovrà costruire quel percorso e riservare atomicamente le richieste.
import { TOLLERANZA_MS } from './model.js';
import { verificaQualitaOccorrenze } from './service-quality.js';

const money = n => Math.round(Number(n)*100)/100;
const id = r => Number(r.id);
const validNumber = x => Number.isFinite(Number(x));
const validPositive = x => validNumber(x) && Number(x)>0;

function timeline(plan, departure) {
  if (!Array.isArray(plan?.nodes) || !Array.isArray(plan?.legs) ||
      plan.nodes.length<2 || plan.legs.length!==plan.nodes.length-1 ||
      !Number.isFinite(departure)) throw new Error('Piano o partenza non validi');
  const offsets=[0];
  for (const leg of plan.legs) {
    if (!validPositive(leg.seconds) || !validPositive(leg.metres))
      throw new Error('Segmento di ciclo non valido');
    offsets.push(offsets.at(-1)+Number(leg.seconds)*1000);
  }
  return offsets.map(t=>departure+t);
}

// Identifica TUTTE le occorrenze cronologicamente ammissibili.
// Il nodo può ricomparire più volte nello stesso ciclo.
// Non impone un ruolo commerciale alla richiesta.
export function trovaOccorrenzeCompatibili(plan, richiesta, departure, options={}) {
  const dates=timeline(plan,departure);
  const tolerance=options.tolleranzaMs ?? TOLLERANZA_MS;
  if (!Number.isFinite(tolerance) || tolerance<0) throw new Error('Tolleranza non valida');
  const target=new Date(richiesta.start_datetime).getTime();
  if (!Number.isFinite(target)) return [];
  const results=[];
  for(let start=0;start<plan.nodes.length-1;start++){
    if(Number(plan.nodes[start])!==Number(richiesta.start_node_id))continue;
    if(Math.abs(dates[start]-target)>tolerance)continue;
    for(let end=start+1;end<plan.nodes.length;end++){
      if(Number(plan.nodes[end])!==Number(richiesta.end_node_id))continue;
      results.push({richiesta,start,end,partenza:dates[start],arrivo:dates[end]});
    }
  }
  return results;
}

// Costruisce combinazioni senza duplicare richieste.
// options:
//  maxPosti (obbligatorio), baseAssignments (richieste già a bordo),
//  maxRisultati (default 100), qualityOptions,
//  tolleranzaMs, includeIds (richieste obbligatorie)
// Se baseAssignments è usato, ciascun elemento è {richiesta,start,end}.
// I posti sono verificati per segmento, non sull'intero veicolo.
// La ricerca è limitata e deterministica, NON esaustiva.
export function generaRitorniCompatibili(plan, richieste, departure, options={}) {
  const maxPosti=Number(options.maxPosti);
  if (!Number.isSafeInteger(maxPosti)||maxPosti<=0) throw new Error('maxPosti obbligatorio e positivo');
  const limit=Math.min(500,Math.max(1,Math.trunc(Number(options.maxRisultati??100))));
  if (!Number.isFinite(limit)) throw new Error('maxRisultati non valido');
  const base=options.baseAssignments||[];
  const mandatory=new Set((options.includeIds||[]).map(Number));
  const occupancy=Array(plan.legs.length).fill(0);
  const used=new Set();
  for(const a of base){
    const r=a.richiesta;
    if(!r || !Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end) ||
       a.start<0||a.end>occupancy.length||a.start>=a.end ||
       !Number.isSafeInteger(id(r))||!Number.isSafeInteger(Number(r.posti_richiesti))||
       Number(r.posti_richiesti)<=0||used.has(id(r)))
      return [];
    used.add(id(r));
    for(let i=a.start;i<a.end;i++) occupancy[i]+=Number(r.posti_richiesti);
  }
  if(occupancy.some(n=>n>maxPosti))return [];
  if(!verificaQualitaOccorrenze(plan,base,options.qualityOptions).ok)return [];

  const possibilities=[...richieste]
    .filter(r=>!used.has(id(r)) && Number.isSafeInteger(id(r)) &&
      Number.isSafeInteger(Number(r.posti_richiesti)) &&
      Number(r.posti_richiesti)>0 && validNumber(r.prezzo) && Number(r.prezzo)>=0)
    .sort((a,b)=>new Date(a.start_datetime)-new Date(b.start_datetime)||id(a)-id(b))
    .map(r=>({r,variants:trovaOccorrenzeCompatibili(plan,r,departure,options)}))
    .filter(x=>x.variants.length);
  const results=[];
  const seen=new Set();
  function record(assignments){
    if(![...mandatory].every(rid=>assignments.some(a=>id(a.richiesta)===rid)))return;
    const k=assignments.map(a=>`${id(a.richiesta)}:${a.start}-${a.end}`).sort().join('|');
    if(seen.has(k))return;
    const quality=verificaQualitaOccorrenze(plan,assignments,options.qualityOptions);
    if(!quality.ok)return;
    seen.add(k);
    results.push({
      assignments:assignments.map(a=>({richiestaId:id(a.richiesta),start:a.start,end:a.end})),
      requestIds:assignments.map(a=>id(a.richiesta)),
      revenue:money(assignments.reduce((sum,a)=>sum+Number(a.richiesta.prezzo||0),0)),
      peak:Math.max(0,...occupancy),
      qualita:quality.dettagli,
      departure,
      arrival:timeline(plan,departure).at(-1)
    });
  }
  const selected=[...base];
  function visit(index){
    if(results.length>=limit)return;
    if(index===possibilities.length){record(selected);return;}
    const {r,variants}=possibilities[index];
    // Non selezionare la richiesta: resta disponibile per altre candidate.
    if(!mandatory.has(id(r)))visit(index+1);
    for(const v of variants){
      if(results.length>=limit)return;
      let fits=true;
      for(let i=v.start;i<v.end;i++)
        if(occupancy[i]+Number(r.posti_richiesti)>maxPosti){fits=false;break;}
      if(!fits)continue;
      const a={richiesta:r,start:v.start,end:v.end};
      selected.push(a);
      const quality=verificaQualitaOccorrenze(plan,selected,options.qualityOptions);
      if(quality.ok){
        for(let i=v.start;i<v.end;i++)occupancy[i]+=Number(r.posti_richiesti);
        visit(index+1);
        for(let i=v.start;i<v.end;i++)occupancy[i]-=Number(r.posti_richiesti);
      }
      selected.pop();
    }
  }
  visit(0);
  return results;
}

// L'economia del ciclo resta di competenza del worker/pricing:
// qui si espone soltanto una valutazione parametrica.
// costEuro deve includere approccio, segmenti reali, collegamenti e
// UN SOLO ritorno finale. thresholdRatio va passato dal chiamante
// in base alle regole economiche e alle classi commerciali.
export function valutaSogliaCiclo(formazione,{costEuro,thresholdRatio=1}={}){
  if(!validNumber(costEuro)||Number(costEuro)<0 ||
     !validNumber(thresholdRatio)||Number(thresholdRatio)<0)
    throw new Error('Parametri economici non validi');
  const ricavo=Number(formazione.revenue);
  if(!Number.isFinite(ricavo)||ricavo<0)throw new Error('Ricavo non valido');
  const soglia=money(Number(costEuro)*Number(thresholdRatio));
  return {ricavo:money(ricavo),costo:money(costEuro),soglia,
    attivabile:ricavo+1e-8>=soglia};
}
