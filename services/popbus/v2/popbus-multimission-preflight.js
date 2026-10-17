// POPBUS P0-C: validazione pura e fail-closed del piano globale.
// Non esegue SQL, pagamenti o modifiche di stato.
const finite = (x) => Number.isFinite(Number(x));
const integer = (x) => Number.isSafeInteger(Number(x));
function check(ok, msg) { if (!ok) throw new Error(`POPBUS MULTI PREFLIGHT: ${msg}`); }
export function validaPianoMultiMissione(plan, { veicoloId, postiTotali } = {}) {
  check(plan?.tipoPiano === 'CICLO_PIXEL_CORSA_UNICA_V1', 'tipo piano non riconosciuto');
  check(Array.isArray(plan.missioni) && plan.missioni.length >= 2 && plan.missioni.length <= 3, 'numero missioni');
  check(Array.isArray(plan.nodes) && plan.nodes.length >= 3, 'nodi');
  const n = plan.nodes.length;
  check(Array.isArray(plan.coordinates) && plan.coordinates.length === n, 'coordinate');
  check(Array.isArray(plan.legs) && plan.legs.length === n - 1, 'tratte');
  check(Array.isArray(plan.evaluation?.times) && plan.evaluation.times.length === n, 'tempi');
  check(Array.isArray(plan.evaluation?.requests) && plan.evaluation.requests.length > 0, 'richieste');
  check(integer(veicoloId) && Number(plan.veicoloId) === Number(veicoloId), 'veicolo non coerente');
  if (postiTotali != null) check(integer(postiTotali) && Number(postiTotali) > 0, 'capienza veicolo');
  const departure = Number(plan.evaluation.departure), arrival = Number(plan.evaluation.arrival);
  const bs = Date.parse(plan.busyStart), be = Date.parse(plan.busyEnd);
  check([departure,arrival,bs,be].every(Number.isFinite) && bs <= departure && departure < arrival && arrival <= be, 'intervallo busy');
  check(Number(plan.evaluation.times[0]) === 0, 'offset iniziale');
  let cumulative = 0;
  for (let i=0; i<n; i++) {
    const node = plan.coordinates[i];
    check(integer(plan.nodes[i]) && Number(plan.nodes[i]) > 0 && Number(node?.id) === Number(plan.nodes[i]), `nodo ${i}`);
    check(finite(node?.lat) && finite(node?.lon) && Math.abs(Number(node.lat)) <= 90 && Math.abs(Number(node.lon)) <= 180, `coordinate ${i}`);
    check(finite(plan.evaluation.times[i]) && Math.abs(Number(plan.evaluation.times[i]) - cumulative) <= 1, `tempo ${i}`);
    if (i < n-1) {
      const leg = plan.legs[i];
      check(finite(leg?.seconds) && Number(leg.seconds) >= 0 && finite(leg?.metres) && Number(leg.metres) >= 0 && typeof leg?.polyline === 'string' && leg.polyline.length > 0, `tratta ${i}`);
      cumulative += Number(leg.seconds) * 1000;
    }
  }
  check(Math.abs(departure + cumulative - arrival) <= 1000, 'arrivo e tempi');
  let previousEnd = -1;
  for (let i=0; i<plan.missioni.length; i++) {
    const m = plan.missioni[i];
    const s = Number(m?.startIndex), e = Number(m?.endIndex);
    check(Number(m?.ordine) === i+1 && integer(s) && integer(e) && s >= 0 && e > s && e < n && s > previousEnd - 1, `missione ${i+1}: indici`);
    check(finite(m.partenza) && finite(m.arrivo) && Math.abs(departure + Number(plan.evaluation.times[s]) - Number(m.partenza)) <= 1000 && Math.abs(departure + Number(plan.evaluation.times[e]) - Number(m.arrivo)) <= 1000, `missione ${i+1}: orari`);
    previousEnd = e;
  }
  const delta = Array(n).fill(0), ids = new Set();
  for (const r of plan.evaluation.requests) {
    const id=Number(r?.id), s=Number(r?.start), e=Number(r?.end);
    check(integer(id) && id>0 && !ids.has(id) && integer(s) && integer(e) && s>=0 && e>s && e<n, 'richiesta o indici');
    ids.add(id);
    check(plan.missioni.some(m => s >= Number(m.startIndex) && e <= Number(m.endIndex)), `richiesta ${id} fuori missione`);
    // I posti non sono parte dell'output dell'assembler: sono obbligatori nel contesto rivalidato.
  }
  return { richiestaIds:[...ids], numeroMissioni:plan.missioni.length, nodi:n, intervallo:{busyStart:new Date(bs).toISOString(),busyEnd:new Date(be).toISOString()}, necessitaPostiDaDatabase:true };
}
export function validaOccupazioneMultiMissione(plan, richieste, postiTotali) {
  check(Array.isArray(richieste) && richieste.length === plan.evaluation.requests.length, 'richieste DB incomplete');
  const byId=new Map();
  for (const r of richieste) {
    const id=Number(r.id), posti=Number(r.posti_richiesti);
    check(integer(id) && !byId.has(id) && integer(posti) && posti>0, 'posti DB non validi');
    byId.set(id,posti);
  }
  const delta=Array(plan.nodes.length).fill(0);
  let totale=0;
  for (const r of plan.evaluation.requests) {
    const posti=byId.get(Number(r.id));
    check(posti != null, `richiesta ${r.id} assente`);
    delta[Number(r.start)]+=posti;
    delta[Number(r.end)]-=posti;
    totale+=posti;
  }
  let current=0,peak=0;
  for (const d of delta) { current+=d; check(current>=0,'occupazione negativa'); peak=Math.max(peak,current); }
  check(current===0 && peak<=Number(postiTotali), 'capienza superata');
  return { peak, totalePasseggeri:totale, postiDisponibili:Number(postiTotali)-peak };
}
