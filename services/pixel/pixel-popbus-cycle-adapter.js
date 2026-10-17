// TURENTU PIXEL -> POPBUS V2 | DIAGNOSTICA PURA, NESSUNA QUERY O ATTIVAZIONE
import { valutaRichieste, verificaQualitaRichieste } from '../popbus/v2/model.js';
import { valutaEconomiaCiclo } from '../popbus/v2/cycle-pricing.js';

const finite = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const integer = x => Number.isSafeInteger(Number(x));
const ms = x => new Date(x).getTime();
const same = (a,b) => Math.abs(Number(a.lat)-Number(b.lat)) < 1e-7 && Math.abs(Number(a.lon)-Number(b.lon)) < 1e-7;
const sum = (xs,key) => xs.reduce((a,x)=>a+Number(x[key]),0);
const failure = (motivo, dettagli={}) => ({ok:false, motivo, ...dettagli, attivabile:false});

function validateLeg(l) {
  return l && finite(l.metres) && finite(l.seconds) && Number(l.metres)>=0 && Number(l.seconds)>=0 &&
    ((Number(l.metres)>0 && Number(l.seconds)>0) ||
     (Number(l.metres)===0 && Number(l.seconds)===0 && l.roadCoincident===true));
}
async function travel(road,a,b) {
  if (same(a,b)) return {metres:0,seconds:0,roadCoincident:true};
  const r=await road(a,b);
  if (!validateLeg(r)) throw Error('ROUTING_NON_VALIDO');
  return r;
}
function evaluateCorridor(engine, corridorId, selected, vehicle) {
  const corridor=engine.getCorridor(corridorId);
  if (!corridor || !Array.isArray(corridor.nodes) || !Array.isArray(corridor.legs) ||
      corridor.legs.length!==corridor.nodes.length-1 || corridor.legs.some(l=>!validateLeg(l)))
    return failure('CORRIDOIO_NON_VALIDO');
  const ids=selected.map(r=>Number(r.id));
  if (!ids.length || new Set(ids).size!==ids.length) return failure('RICHIESTE_NON_VALIDE');
  for (const r of selected) {
    const px=engine.getRequest(r.id);
    if (!px || !corridor.richiestaIds.includes(Number(r.id))) return failure('RICHIESTA_NON_ASSOCIATA');
    if (Number(px.start_node_id)!==Number(r.start_node_id) || Number(px.end_node_id)!==Number(r.end_node_id))
      return failure('NODI_RICHIESTA_INCOERENTI');
    if (!integer(r.posti_richiesti) || Number(r.posti_richiesti)<=0 || !finite(r.prezzo) || Number(r.prezzo)<0 ||
        !Number.isFinite(ms(r.start_datetime))) return failure('DATI_RICHIESTA_INVALIDI');
    // Evita di usare un'istanza PIXEL obsoleta quando orario o capienza cambiano.
    if (px.start_datetime !== undefined && ms(px.start_datetime)!==ms(r.start_datetime)) return failure('ORARIO_RICHIESTA_INCOERENTE');
    if (px.posti_richiesti !== undefined && Number(px.posti_richiesti)!==Number(r.posti_richiesti)) return failure('POSTI_RICHIESTA_INCOERENTI');
  }
  const plan={nodes:corridor.nodes,legs:corridor.legs};
  const q=verificaQualitaRichieste(plan,selected);
  if (!q.ok) return failure('QUALITA_NON_VALIDA',{dettaglio:q.motivo});
  const evaluation=valutaRichieste(plan,selected,ids,{mode:'seeds_only',maxPeak:Number(vehicle.posti_totali)});
  if (!evaluation || evaluation.requests.length!==ids.length) return failure('COMPATIBILITA_NON_SUPERATA');
  return {ok:true,plan,evaluation,requests:selected};
}

/**
 * Combina missioni PIXEL gia' selezionate: [{corridorId,requestIds}].
 * Non interpreta le finestre PIXEL come missioni confermate: rivalida ogni missione.
 * road(a,b) DEVE restituire routing stradale verificato (non distanza in linea d'aria).
 * validateVehicle(v,busyStart,busyEnd,context) e validateCandidate(result,context)
 * sono richiesti per un esito validato; mai per un'attivazione automatica.
 * Le richieste devono avere ID nodi nello stesso namespace dei corridoi PIXEL.
 */
export async function diagnosticaCicloPixelPopbus({engine,missioni,richieste,vehicle,nodes,road,
  validateVehicle,validateCandidate,now=Date.now(),costoAttesaOraEuro=0,maxWaitMin=180}={}) {
  if (!engine || typeof engine.getCorridor!=='function' || typeof engine.getRequest!=='function') throw TypeError('Engine PIXEL non valido');
  if (!Array.isArray(missioni) || missioni.length<1 || missioni.length>3) return failure('NUMERO_MISSIONI_NON_SUPPORTATO');
  if (!Array.isArray(richieste) || !Array.isArray(nodes) || typeof road!=='function' || !vehicle) throw TypeError('Input incompleto');
  if (!integer(vehicle.id) || !integer(vehicle.posti_totali) || Number(vehicle.posti_totali)<=0 ||
      !finite(vehicle.euro_km) || Number(vehicle.euro_km)<=0 || !finite(vehicle.lat) || !finite(vehicle.lon))
    return failure('VEICOLO_NON_VALIDO');
  const byId=new Map(richieste.map(r=>[Number(r.id),r]));
  const nodeMap=new Map(nodes.map(n=>[Number(n.id),n]));
  if (byId.size!==richieste.length || nodeMap.size!==nodes.length) return failure('ID_DUPLICATI');
  const evaluations=[], used=new Set();
  for (const m of missioni) {
    if (!m || !Array.isArray(m.requestIds) || !m.requestIds.length) return failure('MISSIONE_SENZA_RICHIESTE');
    const selected=[];
    for (const id of m.requestIds) {
      if (!integer(id) || used.has(Number(id))) return failure('RICHIESTA_DUPLICATA');
      const r=byId.get(Number(id));
      if (!r) return failure('RICHIESTA_MANCANTE',{id});
      used.add(Number(id));selected.push(r);
    }
    const e=evaluateCorridor(engine,m.corridorId,selected,vehicle);
    if (!e.ok) return {...e,corridorId:m.corridorId};
    if (e.plan.nodes.some(id=>!nodeMap.has(Number(id)))) return failure('NODO_MANCANTE');
    evaluations.push(e);
  }
  // Sequenza temporale delle missioni: nessuna modifica arbitraria agli orari richiesti.
  for(let i=1;i<evaluations.length;i++) {
    if (evaluations[i].evaluation.departure<=evaluations[i-1].evaluation.departure)
      return failure('ORDINE_MISSIONI_NON_CRONOLOGICO');
  }
  let approach,back;
  const links=[];
  try {
    const first=evaluations[0],last=evaluations.at(-1);
    approach=await travel(road,vehicle,nodeMap.get(Number(first.plan.nodes[0])));
    back=await travel(road,nodeMap.get(Number(last.plan.nodes.at(-1))),vehicle);
    for(let i=1;i<evaluations.length;i++) {
      const prev=evaluations[i-1],cur=evaluations[i];
      const transfer=await travel(road,nodeMap.get(Number(prev.plan.nodes.at(-1))),nodeMap.get(Number(cur.plan.nodes[0])));
      const waitMs=cur.evaluation.departure-prev.evaluation.arrival-Number(transfer.seconds)*1000;
      if(waitMs<0) return failure('TRASFERIMENTO_TEMPORALMENTE_IMPOSSIBILE',{indice:i});
      if(waitMs>maxWaitMin*60000) return failure('ATTESA_ECCESSIVA',{indice:i});
      links.push({transfer,waitMs});
    }
  } catch(e) {return failure('ROUTING_FALLITO',{dettaglio:String(e.message||e)});}
  const busyStart=evaluations[0].evaluation.departure-Number(approach.seconds)*1000;
  const busyEnd=evaluations.at(-1).evaluation.arrival+Number(back.seconds)*1000;
  if (!Number.isFinite(busyStart)||!Number.isFinite(busyEnd)||busyStart<=now||busyEnd<=busyStart)
    return failure('INTERVALLO_VEICOLO_NON_VALIDO');
  const commercialMetres=evaluations.reduce((s,e)=>s+sum(e.plan.legs,'metres'),0);
  const transferMetres=links.reduce((s,l)=>s+Number(l.transfer.metres),0);
  const selected=[...used].map(id=>byId.get(id));
  let economia;
  try {
    economia=valutaEconomiaCiclo({ricaviRichiesteEuro:selected.map(r=>Number(r.prezzo)),
      kmAvvicinamento:Number(approach.metres)/1000,kmMissioni:commercialMetres/1000,
      kmTrasferimenti:transferMetres/1000,kmRitornoBase:Number(back.metres)/1000,
      euroKm:Number(vehicle.euro_km),oreAttesa:links.reduce((s,l)=>s+l.waitMs,0)/3600000,
      costoAttesaOraEuro});
  } catch(e) {return failure('ECONOMIA_NON_VALIDA',{dettaglio:e.message});}
  const result={ok:true,attivabile:false,veicoloId:Number(vehicle.id),titolareId:vehicle.driver_id??null,
    approach:{...approach},returnTrip:{...back},
    richieste:[...used],missioni:evaluations.map((e,i)=>({corridorId:missioni[i].corridorId,
      legs:e.plan.legs.map(l=>({...l})),nodes:[...e.plan.nodes],
      departure:e.evaluation.departure,arrival:e.evaluation.arrival,peak:e.evaluation.peak,
      occupancy:e.evaluation.occupancy,requests:e.evaluation.requests.map(r=>({
        ...r,
        posti_richiesti:Number(e.requests.find(x=>Number(x.id)===Number(r.id)).posti_richiesti)
      }))})),
    trasferimenti:links.map(l=>({metres:l.transfer.metres,seconds:l.transfer.seconds,
      leg:{...l.transfer},attesaMinuti:l.waitMs/60000})),
    busyStart,busyEnd,economia,validazionePreliminare:false,
    stato:'DIAGNOSTICO_NON_ATTIVABILE'};
  if (!economia.economicamenteAttivabile) return {...result,ok:false,motivo:'ECONOMIA_NETTA_INSUFFICIENTE'};
  if (typeof validateVehicle==='function') {
    try {if (!await validateVehicle(vehicle,busyStart,busyEnd,result)) return {...result,ok:false,motivo:'VEICOLO_NON_DISPONIBILE'};}
    catch(e){return {...result,ok:false,motivo:'VALIDAZIONE_VEICOLO_FALLITA',dettaglio:e.message};}
  }
  if (typeof validateCandidate==='function') {
    try {if (!await validateCandidate(result,{vehicle,richieste:selected})) return {...result,ok:false,motivo:'REGOLE_COMMERCIALI_NON_SUPERATE'};}
    catch(e){return {...result,ok:false,motivo:'VALIDAZIONE_CANDIDATO_FALLITA',dettaglio:e.message};}
  }
  result.validazionePreliminare=typeof validateVehicle==='function'&&typeof validateCandidate==='function';
  return result;
}
