// ============================================================
// TURENTU POPBUS V2 — FLEET CANDIDATES (SHADOW / READ ONLY)
// Generazione missioni singole e catene (max 3) dal Test 10B.
// Modalita LAUNCH: ammette cicli a pareggio DOPO commissione Turentu (margine netto >= 0).
// Nessuna query DB, scrittura, pagamento, socket o attivazione.
// Input espliciti: richieste, nodi, veicoli, road(), validatori.
// Output compatibile con ottimizzaFlotta().
// ATTENZIONE: candidati PRELIMINARI, NON pronti per attivazione.
// ============================================================

// Commissione sulla somma dei prezzi cliente (lordi). Non applicare a prezzi gia netti.
const COMMISSIONE_TURENTU_BPS = 1500; // 15,00%
const BPS = 10000;

const DEFAULTS = Object.freeze({
  maxDepth: 3,
  maxWaitMin: 180,
  bufferMin: 0,
  maxGroupRequests: 12,
  maxAggregateCombos: 2500,
  maxFormations: 2500,
  maxChains: 500,
  maxCombosPerChainVehicle: 20000,
  maxTotalChainCombos: 100000,
  nearTransferMetres: 8,
  costoAttesaOra: 0,
  includePast: false,
  now: Date.now(),
  strict: true
});

const num = x => Number(x);
const cents = x => Math.round((num(x) + Math.sign(num(x)) * Number.EPSILON) * 100);
const euro = x => Math.round(x) / 100;
const dateMs = x => x instanceof Date ? x.getTime() : new Date(x).getTime();
const coord = p => p && Number.isFinite(num(p.lat)) && Number.isFinite(num(p.lon)) &&
  Math.abs(num(p.lat)) <= 90 && Math.abs(num(p.lon)) <= 180;
const posEqual = (a,b) => Math.abs(num(a.lat)-num(b.lat)) < 1e-7 &&
  Math.abs(num(a.lon)-num(b.lon)) < 1e-7;

function metresLine(a,b) {
  const rad = Math.PI / 180, p1 = num(a.lat)*rad, p2 = num(b.lat)*rad;
  const dp = p2-p1, dl = (num(b.lon)-num(a.lon))*rad;
  const h = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 12742000 * Math.asin(Math.min(1,Math.sqrt(h)));
}

function settings(options) {
  const c = {...DEFAULTS, ...options};
  for (const k of ['maxDepth','maxGroupRequests','maxAggregateCombos','maxFormations',
    'maxChains','maxCombosPerChainVehicle','maxTotalChainCombos']) {
    if (!Number.isSafeInteger(c[k]) || c[k] < 1) throw Error(`Configurazione ${k} non valida`);
  }
  if (c.maxDepth > 3) throw Error('maxDepth > 3 non collaudato');
  for (const k of ['maxWaitMin','bufferMin','nearTransferMetres','costoAttesaOra']) {
    if (!Number.isFinite(c[k]) || c[k] < 0) throw Error(`Configurazione ${k} non valida`);
  }
  if (!Number.isFinite(c.now)) throw Error('now non valido');
  return c;
}

function validateInput(requests,nodes,vehicles,road) {
  if (!Array.isArray(requests) || !Array.isArray(nodes) || !Array.isArray(vehicles) ||
      typeof road !== 'function') throw Error('Input: richieste, nodi, veicoli, road() obbligatori');
  const nodeMap = new Map();
  for (const n of nodes) {
    const id = num(n.id);
    if (!Number.isSafeInteger(id) || nodeMap.has(id) || !coord(n)) throw Error('Nodo invalido o duplicato');
    nodeMap.set(id,n);
  }
  const requestIds = new Set();
  for (const r of requests) {
    const id = num(r.id);
    if (!Number.isSafeInteger(id) || id <= 0 || requestIds.has(id)) throw Error('ID richiesta invalido o duplicato');
    requestIds.add(id);
    if (!nodeMap.has(num(r.start_node_id)) || !nodeMap.has(num(r.end_node_id)) ||
        num(r.start_node_id) === num(r.end_node_id) || !Number.isFinite(dateMs(r.start_datetime)) ||
        !Number.isSafeInteger(num(r.posti_richiesti)) || num(r.posti_richiesti) <= 0 ||
        r.prezzo == null || !Number.isFinite(num(r.prezzo)) || num(r.prezzo) < 0)
      throw Error(`Richiesta ${id} non valida`);
  }
  const vehicleIds = new Set();
  for (const v of vehicles) {
    const id = num(v.id);
    if (!Number.isSafeInteger(id) || id <= 0 || vehicleIds.has(id) ||
        !coord(v) || !Number.isSafeInteger(num(v.posti_totali)) ||
        num(v.posti_totali) <= 0 || !Number.isFinite(num(v.euro_km)) || num(v.euro_km) <= 0)
      throw Error(`Veicolo ${id} non valido`);
    vehicleIds.add(id);
  }
  return nodeMap;
}

function aggregate(group, maxSeats, c, diag) {
  const sorted = [...group].sort((a,b) => num(b.prezzo)-num(a.prezzo) || num(a.id)-num(b.id));
  if (sorted.length > c.maxGroupRequests) diag.limiti.push('MAX_GROUP_REQUESTS');
  const limited = sorted.slice(0,c.maxGroupRequests);
  const combos = [];
  let truncated = false;
  function dfs(from, picked, seats, revenueCents) {
    if (picked.length) {
      if (combos.length >= c.maxAggregateCombos) {truncated=true;return;}
      combos.push({ids:picked.map(r=>num(r.id)).sort((a,b)=>a-b),
        seats, revenueCents, requests:[...picked]});
    }
    for (let i=from;i<limited.length;i++) {
      if (truncated) return;
      const newSeats=seats+num(limited[i].posti_richiesti);
      if (newSeats<=maxSeats) dfs(i+1,[...picked,limited[i]],newSeats,
        revenueCents+cents(limited[i].prezzo));
    }
  }
  dfs(0,[],0,0);
  if (truncated) diag.limiti.push('MAX_AGGREGATE_COMBOS');
  combos.sort((a,b)=>b.revenueCents-a.revenueCents || a.seats-b.seats);
  if (combos.length>c.maxFormations) diag.limiti.push('MAX_FORMATIONS');
  return combos.slice(0,c.maxFormations);
}

/**
 * @param {Object} input
 * requests: righe richieste_pop_bus gia' filtrate dal chiamante
 * nodes: [{id,lat,lon}], vehicles: [{id,lat,lon,posti_totali,euro_km,...}]
 * road(a,b,context): Promise<{metres,seconds}>; puo' richiamare planner.leg()
 * validateVehicle(vehicle,startMs,endMs): Promise<boolean> (turni + conflitti DB)
 * validateCandidate(candidate): Promise<boolean> (pagamenti, qualita, soglie,
 *    raggio operativo, regole commerciali); obbligatorio per validati=true
 *
 * Il filtro commerciale e la soglia DEVONO considerare il ritorno alla base
 * e la commissione del 15% sui prezzi lordi delle richieste.
 * Nessuna deduzione di validita' dalla sola copertura dei costi.
 */
export async function generaCandidatiFlotta(input, options={}) {
  const c=settings(options);
  const {requests,nodes,vehicles,road,validateVehicle,validateCandidate}=input;
  const nodeMap=validateInput(requests,nodes,vehicles,road);
  const diag={
    richieste:requests.length,veicoli:vehicles.length,gruppi:0,missioni:0,
    catene:0,combinazioniCatene:0,candidatiPreliminari:0,candidatiValidati:0,
    routingErrori:[],limiti:[],approssimazioniTecniche:0,
    nonValidati:0,scartiTurniConflitti:0,scartiCommerciali:0
  };
  const cache=new Map();
  async function route(a,b,context='TRANSFER') {
    if (!coord(a)||!coord(b)) return null;
    // Coordinate identiche: nessuno spostamento necessario.
    if (posEqual(a,b)) return {metres:0,seconds:0,roadCoincident:true};
    // Non dedurre mai una coincidenza stradale dalla sola vicinanza in linea d'aria.
    // Anche i TRANSFER vicini passano attraverso road(), che deve preservare
    // roadCoincident restituito da planner.leg().
    const key=`${a.lat},${a.lon}>${b.lat},${b.lon}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const r=await road(a,b,context);
      const metres=num(r?.metres);
      const seconds=num(r?.seconds);
      const normale=Number.isFinite(metres) && Number.isFinite(seconds) &&
        metres>0 && seconds>0;
      const coincidente=r?.roadCoincident===true &&
        metres===0 && seconds===0 &&
        metresLine(a,b)<=c.nearTransferMetres;
      if (!normale && !coincidente) throw Error('Routing incompleto o zero non certificato');
      const value={metres,seconds,roadCoincident:coincidente};
      cache.set(key,value);
      return value;
    } catch(e) {
      diag.routingErrori.push({key,messaggio:String(e.message||e)});
      return null;
    }
  }
  const grouped=new Map();
  for (const r of requests) {
    const k=`${r.start_node_id}|${r.end_node_id}|${dateMs(r.start_datetime)}`;
    if (!grouped.has(k)) grouped.set(k,[]);
    grouped.get(k).push(r);
  }
  diag.gruppi=grouped.size;
  const maxSeats=Math.max(0,...vehicles.map(v=>num(v.posti_totali)));
  const groups=[];
  for (const group of grouped.values()) {
    const first=group[0],start=nodeMap.get(num(first.start_node_id)),
      end=nodeMap.get(num(first.end_node_id));
    const trip=await route(start,end,'COMMERCIAL');
    if (!trip) continue;
    const formations=aggregate(group,maxSeats,c,diag);
    if (!formations.length) continue;
    const depart=dateMs(first.start_datetime),arrive=depart+trip.seconds*1000;
    groups.push(formations.map(f=>({...f,start,end,trip,depart,arrive})));
    diag.missioni+=formations.length;
  }
  groups.sort((a,b)=>a[0].depart-b[0].depart);
  const edges=new Map();
  for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++) {
    const a=groups[i][0],b=groups[j][0];
    if(b.depart<=a.depart || b.depart-a.arrive>(c.maxWaitMin+c.bufferMin+240)*60000)continue;
    const transfer=await route(a.end,b.start,'TRANSFER');
    if(!transfer)continue;
    const wait=b.depart-a.arrive-transfer.seconds*1000-c.bufferMin*60000;
    if(wait<0 || wait>c.maxWaitMin*60000)continue;
    if(!edges.has(i))edges.set(i,[]);
    edges.get(i).push({to:j,transfer,wait});
  }
  const chains=[];
  function visit(path,links) {
    if(chains.length>=c.maxChains){diag.limiti.push('MAX_CHAINS');return;}
    if(path.length>=2)chains.push({path:[...path],links:[...links]});
    if(path.length>=c.maxDepth)return;
    for(const e of edges.get(path.at(-1))||[]) {
      if(chains.length>=c.maxChains){diag.limiti.push('MAX_CHAINS');break;}
      visit([...path,e.to],[...links,e]);
    }
  }
  for(let i=0;i<groups.length;i++) {
    if(chains.length>=c.maxChains)break;
    visit([i],[]);
  }
  diag.catene=chains.length;
  const preliminary=[];
  const dutyCache=new Map();
  async function vehicleDuty(v,first,last,links) {
    const k=`${v.id}|${first.start.id}|${last.end.id}|${first.depart}|${last.arrive}`;
    if(dutyCache.has(k))return dutyCache.get(k);
    const approach=await route(v,first.start),back=await route(last.end,v);
    if(!approach||!back)return null;
    const start=first.depart-approach.seconds*1000;
    const end=last.arrive+back.seconds*1000;
    const duty={start,end,approach,back,
      technicalMetres:approach.metres+back.metres+links.reduce((s,l)=>s+l.transfer.metres,0),
      waitHours:links.reduce((s,l)=>s+l.wait,0)/3600000};
    dutyCache.set(k,duty);
    return duty;
  }
  async function pushCandidate(v,selected,links) {
    const duty=await vehicleDuty(v,selected[0],selected.at(-1),links);
    if(!duty)return;
    if(!c.includePast && duty.start<=c.now)return;
    if(typeof validateVehicle==='function') {
      let ok=false;
      try{ok=await validateVehicle(v,duty.start,duty.end);}
      catch(e){diag.routingErrori.push({tipo:'VALIDATORE_VEICOLO',messaggio:String(e.message||e)});}
      if(!ok){diag.scartiTurniConflitti++;return;}
    }
    const commercialMetres=selected.reduce((s,m)=>s+m.trip.metres,0);
    const totalMetres=duty.technicalMetres+commercialMetres;
    const costCents=Math.ceil(totalMetres/1000*num(v.euro_km)*100-1e-9);
    const waitCents=cents(duty.waitHours*c.costoAttesaOra);
    const revenueCents=selected.reduce((s,m)=>s+m.revenueCents,0);
    // Ricavo lordo da richieste_pop_bus.prezzo. La commissione Turentu e'
    // trattenuta sul lordo: la soglia copre il costo autista + attesa
    // DOPO la trattenuta. Aritmetica in centesimi e basis points.
    const commissionCents=Math.round(revenueCents*COMMISSIONE_TURENTU_BPS/BPS);
    const netRevenueCents=revenueCents-commissionCents;
    const fullCostCents=costCents+waitCents;
    // Soglia lorda minima teorica (in centesimi), arrotondata verso l'alto.
    // L'ammissibilita' viene comunque verificata sul netto effettivo
    // arrotondato della commissione, evitando errori al centesimo.
    const thresholdCents=Math.ceil(fullCostCents*BPS/(BPS-COMMISSIONE_TURENTU_BPS));
    const marginCents=netRevenueCents-fullCostCents;
    // LAUNCH: pareggio netto ammissibile, sottocosto netto escluso.
    // Il costo include avvicinamento, trasferimenti, ritorno e attesa.
    if(marginCents<0)return;
    const candidate={
      veicolo:num(v.id),
      richieste:selected.map(m=>[...m.ids]),
      missioni:selected.length,
      partenza_base:new Date(duty.start).toISOString(),
      ritorno_base:new Date(duty.end).toISOString(),
      ricavo_euro:euro(revenueCents),
      commissione_turentu_euro:euro(commissionCents),
      ricavo_netto_euro:euro(netRevenueCents),
      soglia_attivazione_lorda_euro:euro(thresholdCents),
      costo_completo_euro:euro(costCents),
      costo_attesa_euro:euro(waitCents),
      margine_ciclo_con_attesa_euro:euro(marginCents),
      km_totali:totalMetres/1000,
      classe_richieste:[...new Set(selected.flatMap(m=>m.requests.map(r=>r.classe)))],
      tipo_candidato:selected.length===1?'MISSIONE_SINGOLA':'CATENA',
      dettaglio_missioni:selected.map(m=>({
        richieste:[...m.ids],origine:num(m.start.id),destinazione:num(m.end.id),
        partenza:new Date(m.depart).toISOString(),arrivo:new Date(m.arrive).toISOString(),
        posti:m.seats,ricavo_euro:euro(m.revenueCents)
      })),
      // Nessuna dichiarazione di attivabilita' senza validatori.
      validazione_preliminare:false
    };
    if(typeof validateCandidate==='function') {
      let ok=false;
      try{ok=await validateCandidate(candidate,{vehicle:v,selected,duty,links});}
      catch(e){diag.routingErrori.push({tipo:'VALIDATORE_CANDIDATO',messaggio:String(e.message||e)});}
      if(!ok){diag.scartiCommerciali++;return;}
    }
    candidate.validazione_preliminare=
      typeof validateVehicle==='function' && typeof validateCandidate==='function';
    if(candidate.validazione_preliminare)diag.candidatiValidati++;
    else diag.nonValidati++;
    preliminary.push(candidate);
  }
  // Prima missioni singole: priorita' di routing come Test 10B.
  for(const v of vehicles)for(const g of groups)for(const m of g) {
    if(m.seats<=num(v.posti_totali))await pushCandidate(v,[m],[]);
  }
  let stop=false;
  for(const chain of chains) {
    if(stop)break;
    for(const v of vehicles) {
      if(stop)break;
      let combos=[{selected:[],used:new Set()}],overflow=false;
      for(const gi of chain.path) {
        const next=[];
        outer:for(const x of combos)for(const m of groups[gi]) {
          if(m.seats>num(v.posti_totali)||m.ids.some(id=>x.used.has(id)))continue;
          if(next.length>=c.maxCombosPerChainVehicle){overflow=true;break outer;}
          next.push({selected:[...x.selected,m],used:new Set([...x.used,...m.ids])});
        }
        combos=next;
        if(overflow||!combos.length)break;
      }
      if(overflow){diag.limiti.push('MAX_COMBOS_PER_CHAIN_VEHICLE');continue;}
      if(diag.combinazioniCatene+combos.length>c.maxTotalChainCombos) {
        diag.limiti.push('MAX_TOTAL_CHAIN_COMBOS');stop=true;break;
      }
      diag.combinazioniCatene+=combos.length;
      for(const x of combos)await pushCandidate(v,x.selected,chain.links);
    }
  }
  diag.candidatiPreliminari=preliminary.length;
  diag.limiti=[...new Set(diag.limiti)];
  diag.enumerazioneSenzaTagli=diag.limiti.length===0;
  diag.routingSenzaErrori=diag.routingErrori.length===0;
  diag.prontoPerOttimizzazioneProduttiva=
    diag.enumerazioneSenzaTagli && diag.routingSenzaErrori &&
    diag.approssimazioniTecniche===0 && diag.nonValidati===0 &&
    typeof validateVehicle==='function' && typeof validateCandidate==='function';
  if(c.strict && !diag.prontoPerOttimizzazioneProduttiva) {
    return {candidati:preliminary,diagnostica:diag,utilizzabiliPerAttivazione:false};
  }
  return {candidati:preliminary,diagnostica:diag,utilizzabiliPerAttivazione:false};
}

export default generaCandidatiFlotta;
