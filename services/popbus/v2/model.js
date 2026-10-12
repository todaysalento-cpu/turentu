export const TOLLERANZA_MS = 30 * 60000;
const key = nodes => nodes.map(Number).join(':');
// Candidate da richieste reali e concatenazioni dirette. Nessun sotto-tratto artificiale.
export function generaCandidate(requests, maxCandidate = 500) {
  const candidates = new Map();
  const queue = [];
  function add(nodes, seeds, classe) {
    if (new Set(nodes).size !== nodes.length) return;
    const k = `${classe}|${key(nodes)}|${seeds.slice().sort((a,b)=>a-b).join(',')}`;
    if (candidates.has(k)) return;
    if (candidates.size >= maxCandidate) throw new Error(`Limite ${maxCandidate} candidate: dividere il batch`);
    const c = {nodes, seeds, classe}; candidates.set(k,c); queue.push(c);
  }
  const valid = requests.filter(r=>Number(r.start_node_id)!==Number(r.end_node_id));
  for(const r of valid) add([Number(r.start_node_id),Number(r.end_node_id)],[Number(r.id)],r.classe||'STANDARD');
  for(let i=0;i<queue.length;i++) {
    const c=queue[i];
    for(const r of valid) {
      if((r.classe||'STANDARD')===c.classe && Number(r.start_node_id)===c.nodes.at(-1) && !c.seeds.includes(Number(r.id))) {
        add([...c.nodes,Number(r.end_node_id)],[...c.seeds,Number(r.id)],c.classe);
      }
    }
  }
  return [...candidates.values()];
}

export function valutaRichieste(plan, requests, seeds) {
  const index = new Map(plan.nodes.map((id,i)=>[Number(id),i]));
  const times=[0];
  for(const leg of plan.legs) {
    if(!Number.isFinite(leg.seconds)||leg.seconds<=0||!Number.isFinite(leg.metres)||leg.metres<=0) throw new Error('Routing non valido');
    times.push(times.at(-1)+leg.seconds*1000);
  }
  if(times.length!==plan.nodes.length) throw new Error('Piano incoerente');
  const eligible=requests.map(r=>{
    const s=index.get(Number(r.start_node_id)),e=index.get(Number(r.end_node_id));
    const date=new Date(r.start_datetime).getTime(),posti=Number(r.posti_richiesti),prezzo=Number(r.prezzo);
    if(s==null||e==null||s>=e||!Number.isFinite(date)||!Number.isInteger(posti)||posti<=0||r.prezzo==null||!Number.isFinite(prezzo)||prezzo<0) return null;
    const base=date-times[s];
    return {r,s,e,lower:base-TOLLERANZA_MS,upper:base+TOLLERANZA_MS};
  }).filter(Boolean);
  let lower=-Infinity,upper=Infinity;
  const selected=[];
  for(const id of seeds) {
    const x=eligible.find(x=>Number(x.r.id)===Number(id));
    if(!x)return null;
    lower=Math.max(lower,x.lower);upper=Math.min(upper,x.upper);
    if(lower>upper)return null;
    selected.push(x);
  }
  for(const x of eligible.sort((a,b)=>Number(a.r.id)-Number(b.r.id))) {
    if(selected.some(y=>y.r.id===x.r.id))continue;
    const l=Math.max(lower,x.lower),u=Math.min(upper,x.upper);
    if(l<=u){lower=l;upper=u;selected.push(x);}
  }
  if(!selected.length)return null;
  const preferred=new Date(selected[0].r.start_datetime).getTime()-times[selected[0].s];
  const departure=Math.max(lower,Math.min(upper,preferred));
  const occupancy=plan.legs.map(()=>0);
  for(const x of selected)for(let i=x.s;i<x.e;i++)occupancy[i]+=Number(x.r.posti_richiesti);
  return {departure,arrival:departure+times.at(-1),times,occupancy,peak:Math.max(...occupancy),
    revenue:selected.reduce((sum,x)=>sum+Math.round(Number(x.r.prezzo)*100),0)/100,
    requests:selected.map(x=>({id:Number(x.r.id),start:x.s,end:x.e}))};
}

// Selezione greedy deterministica: non promette l'ottimo globale.
export function scegliAttivazioni(candidates) {
  const busyRequests=new Set(),busyDrivers=new Set(),busyVehicles=new Set();
  const result=[];
  const sorted=[...candidates].sort((a,b)=>b.evaluation.requests.length-a.evaluation.requests.length ||
    (b.evaluation.revenue-b.cost)-(a.evaluation.revenue-a.cost)||a.cost-b.cost||key(a.plan.nodes).localeCompare(key(b.plan.nodes)));
  for(const c of sorted) {
    if(c.evaluation.revenue<c.cost||c.evaluation.peak>Number(c.vehicle.posti_totali))continue;
    if(c.evaluation.requests.some(r=>busyRequests.has(r.id))||busyDrivers.has(c.vehicle.driver_id)||busyVehicles.has(c.vehicle.id))continue;
    result.push(c);
    c.evaluation.requests.forEach(r=>busyRequests.add(r.id));busyDrivers.add(c.vehicle.driver_id);busyVehicles.add(c.vehicle.id);
  }
  return result;
}
