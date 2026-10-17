// TURENTU PIXEL — finestre di ritorno per nodo e punto di inversione.
// Motore puro: nessuna assegnazione di veicoli, prenotazione o scrittura DB.
// Le richieste sono candidate e possono comparire in alternative differenti.
const err = m => { throw new Error(`PIXEL_NODE_RETURN: ${m}`); };
const stamp = v => v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
const node = (r, k) => Number(r[k]);
function offsets(route) {
  if (!route || !Array.isArray(route.nodes) || !Array.isArray(route.legs) ||
      route.nodes.length < 2 || route.legs.length !== route.nodes.length - 1 ||
      new Set(route.nodes.map(Number)).size !== route.nodes.length) err('percorso non valido');
  const out = [0];
  for (const l of route.legs) {
    if (!Number.isFinite(l?.seconds) || l.seconds < 0 ||
        (l.seconds === 0 && l.roadCoincident !== true)) err('routing non verificato');
    out.push(out.at(-1) + l.seconds * 1000);
  }
  return out;
}
const intersect = (a,b) => ({inizioMs:Math.max(a.inizioMs,b.inizioMs),fineMs:Math.min(a.fineMs,b.fineMs)});
const valid = w => w.inizioMs <= w.fineMs;

// andata: {nodes,legs,finestraPartenza:{inizioMs,fineMs}}.
// ritorno: {nodes,legs} con nodi in ordine inverso rispetto all'andata.
// Ciascun punto di inversione j genera un percorso inverso autonomo:
// [andata.nodes[j], andata.nodes[j-1], ..., andata.nodes[0]].
// I tempi inversi devono essere calcolati con routing reale e forniti in
// ritorniPerInversione: Map<nodeId, {nodes,legs}> oppure oggetto equivalente.
// Per ogni nodo N e inversione J >= N, calcola le finestre di salita a N.
// Non si considera fattibile invertire a J se l'andata selezionata deve
// ancora accompagnare passeggeri oltre J: questo e' un vincolo POPBUS.
export function finestreRitornoPerNodo({andata, ritorniPerInversione,
  richieste = [], tolleranzaMinuti = 30, bufferMinuti = 0}) {
  const forward = offsets(andata);
  const start = andata?.finestraPartenza;
  if (!start || !Number.isFinite(start.inizioMs) || !Number.isFinite(start.fineMs) || !valid(start))
    err('finestra andata non valida');
  if (![tolleranzaMinuti,bufferMinuti].every(v=>Number.isFinite(v)&&v>=0)) err('tolleranza/buffer non validi');
  const tol = tolleranzaMinuti*60000, buffer = bufferMinuti*60000;
  const result = new Map(andata.nodes.map(n=>[Number(n),[]]));
  for (let j=1;j<andata.nodes.length;j++) {
    const inversione = Number(andata.nodes[j]);
    const route = ritorniPerInversione instanceof Map
      ? ritorniPerInversione.get(inversione) : ritorniPerInversione?.[inversione];
    if (!route) continue; // routing non presente: nessuna opportunita' certificata
    const expected = andata.nodes.slice(0,j+1).reverse().map(Number);
    if (JSON.stringify(route.nodes.map(Number)) !== JSON.stringify(expected))
      err(`percorso inverso incoerente per ${inversione}`);
    const reverse = offsets(route);
    const earliest = start.inizioMs + forward[j] + buffer;
    // Finestra di inizio ritorno: l'andata potrebbe partire in qualunque
    // istante della propria finestra. Non si forza un unico orario.
    const feasibleStart = {inizioMs:earliest,fineMs:Infinity};
    const matches = [];
    for (const r of richieste) {
      const s = route.nodes.findIndex(n=>Number(n)===node(r,'origine_nodo_territoriale_id'));
      const e = route.nodes.findIndex(n=>Number(n)===node(r,'destinazione_nodo_territoriale_id'));
      const t = stamp(r.start_datetime);
      if (s<0 || e<=s || !Number.isFinite(t)) continue;
      const window = {inizioMs:t-reverse[s]-tol,fineMs:t-reverse[s]+tol};
      if (window.fineMs < earliest) continue;
      matches.push({richiestaId:r.id,indiceSalita:s,indiceDiscesa:e,
        nodoSalita:Number(route.nodes[s]),finestraInizioRitorno:window});
    }
    // Ogni richiesta origina una candidata. Aggrega solo se l'intersezione
    // complessiva delle finestre rimane non vuota; non e' ricerca esaustiva.
    matches.sort((a,b)=>a.finestraInizioRitorno.inizioMs-b.finestraInizioRitorno.inizioMs || String(a.richiestaId).localeCompare(String(b.richiestaId)));
    const groups=[];
    for (const m of matches) {
      const w = intersect(feasibleStart,m.finestraInizioRitorno);
      const g=groups.find(g=>valid(intersect(g.window,w)));
      if (g) {g.window=intersect(g.window,w);g.items.push(m);}
      else if (valid(w)) groups.push({window:w,items:[m]});
    }
    for (const g of groups) {
      for (let k=0;k<route.nodes.length-1;k++) {
        const nodoSalita=Number(route.nodes[k]);
        const window={inizioMs:g.window.inizioMs+reverse[k],fineMs:g.window.fineMs+reverse[k]};
        const requestsAtNode=g.items.filter(m=>m.nodoSalita===nodoSalita).map(m=>m.richiestaId);
        result.get(nodoSalita).push({
          inversioneNodoId:inversione, nodoSalitaId:nodoSalita,
          finestraPassaggio:window, finestraInizioRitorno:{...g.window},
          richiestaIds:g.items.map(m=>m.richiestaId), richiesteSalitaNodo:requestsAtNode,
          percorsoRitorno:route.nodes.map(Number),
          condizione:'ANDATA_DEVE_POTER_TERMINARE_AL_NODO_INVERSIONE',
          preliminare:true
        });
      }
    }
  }
  return result;
}
