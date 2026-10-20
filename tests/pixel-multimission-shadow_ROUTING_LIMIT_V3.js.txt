// TURENTU POPBUS V2 — GENERATORE MULTI-MISSIONE SHADOW (modulo puro)
// Salva come services/popbus/v2/pixel-multimission-shadow.js
// Nessun database, commit, modifica a PIXEL o attivazione.
// Il chiamante deve fornire missioni PIXEL gia' validate, routing verificato,
// prezzi originali, disponibilita e conflitti. NON e' un certificatore produttivo.
import { valutaEconomiaCiclo } from './cycle-pricing.js';

const fail = message => { throw new Error(`PIXEL_MULTIMISSION_SHADOW: ${message}`); };
const num = (x, name) => { const n=Number(x); if (!Number.isFinite(n) || n<0) fail(`${name} non valido`); return n; };
const positiveId = x => Number.isSafeInteger(Number(x)) && Number(x)>0;
function normalizeMission(m) {
  if (!m || !positiveId(m.pixelOpportunitaId)) fail('opportunita PIXEL non valida');
  if (!m.from || !m.to || !Number.isFinite(Number(m.from.lat)) || !Number.isFinite(Number(m.from.lon)) || !Number.isFinite(Number(m.to.lat)) || !Number.isFinite(Number(m.to.lon))) fail('estremi missione mancanti');
  if (!Array.isArray(m.requests) || !m.requests.length) fail('richieste mancanti');
  const ids=m.requests.map(r=>Number(r.id));
  if (!ids.every(positiveId) || new Set(ids).size!==ids.length) fail('ID richieste non validi');
  const prices=m.requests.map(r=>num(r.prezzo,'prezzo richiesta'));
  const start=Number(m.departure), end=Number(m.arrival);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start>=end) fail('orari missione non validi');
  const km=num(m.kmMissione,'kmMissione');
  return {...m, departure:start,arrival:end,kmMissione:km,requestIds:ids,prices};
}
function legCheck(leg, name) {
  if (!leg || !Number.isFinite(Number(leg.metres)) || !Number.isFinite(Number(leg.seconds))) fail(`${name}: routing mancante`);
  return {metres:num(leg.metres,`${name}.metres`),seconds:num(leg.seconds,`${name}.seconds`)};
}
/**
 * Costruisce solo sequenze di 2 missioni dello stesso veicolo.
 * `missions`: [{pixelOpportunitaId,from,to,departure,arrival,kmMissione,
 *               requests:[{id,prezzo}],peak}]. Orari in millisecondi.
 * `vehicles`: [{id,lat,lon,euroKm,posti_totali}].
 * `movement(from,to)` restituisce {metres,seconds} stradali verificati.
 * `isAvailable(vehicle,busyStart,busyEnd)` verifica l'intero ciclo.
 * `hasConflicts(vehicle,busyStart,busyEnd)` verifica l'intero ciclo.
 * Limiti: fallimento esplicito, mai troncamento silenzioso.
 * Non applica da solo vincoli A/R, qualita', finestre ai punti intermedi,
 * costi reali di attesa, o soglie di classe: responsabilita del chiamante.
 */
export async function generaCicliDueMissioniShadow({missions,vehicles,movement,isAvailable,hasConflicts,
  now=Date.now(),maxPairs=10000,maxRoutingCalls=100,costoAttesaOraEuro=0}={}) {
  if (!Array.isArray(missions) || !Array.isArray(vehicles) ||
      typeof movement!=='function' || typeof isAvailable!=='function' || typeof hasConflicts!=='function') fail('dipendenze mancanti');
  if (!Number.isSafeInteger(maxPairs) || maxPairs<1) fail('maxPairs non valido');
  if (!Number.isSafeInteger(maxRoutingCalls) || maxRoutingCalls<1) fail('maxRoutingCalls non valido');
  num(costoAttesaOraEuro,'costoAttesaOraEuro');
  const normalized=missions.map(normalizeMission);
  const results=[]; let attempted=0;
  // Cache per coordinate e direzione: nessuna distanza simmetrica presunta.
  // Non conserva promesse fallite; errori di routing sempre espliciti.
  const routingCache=new Map();
  const routingStats={richieste:0,chiamateEffettive:0,cacheHit:0};
  const keyPoint=p=>`${Number(p.lat)},${Number(p.lon)}`;
  async function cachedMovement(from,to,name) {
    routingStats.richieste++;
    const key=`${keyPoint(from)}>${keyPoint(to)}`;
    if (routingCache.has(key)) {
      routingStats.cacheHit++;
      return routingCache.get(key);
    }
    if (routingStats.chiamateEffettive >= maxRoutingCalls) {
      fail(`limite routing raggiunto (${maxRoutingCalls}): nessun risultato parziale; ${JSON.stringify(routingStats)}`);
    }
    routingStats.chiamateEffettive++;
    const route=legCheck(await movement(from,to),name);
    routingCache.set(key,route);
    return route;
  }
  // Controllo preventivo del limite: nessun routing prima del fail-closed.
  // Stessi filtri e stesso ordine del generatore originale.
  let pairCount=0;
  for (const v of vehicles) {
    if (!positiveId(v.id) || !Number.isFinite(Number(v.lat)) || !Number.isFinite(Number(v.lon))) fail('veicolo non valido');
    const capacity=num(v.posti_totali,'posti_totali');
    num(v.euroKm,'euroKm');
    for (const a of normalized) for (const b of normalized) {
      if (a===b || a.arrival>b.departure || a.departure<=now) continue;
      if (num(a.peak,'peak')>capacity || num(b.peak,'peak')>capacity) continue;
      if (a.requestIds.some(id=>b.requestIds.includes(id))) continue;
      if (++pairCount>maxPairs) fail('limite coppie raggiunto: nessun risultato parziale');
    }
  }
  for (const v of vehicles) {
    if (!positiveId(v.id) || !Number.isFinite(Number(v.lat)) || !Number.isFinite(Number(v.lon))) fail('veicolo non valido');
    const base={lat:Number(v.lat),lon:Number(v.lon)};
    const capacity=num(v.posti_totali,'posti_totali');
    const euroKm=num(v.euroKm,'euroKm');
    for (const a of normalized) for (const b of normalized) {
      if (a===b || a.arrival>b.departure || a.departure<=now) continue;
      if (num(a.peak,'peak')>capacity || num(b.peak,'peak')>capacity) continue;
      if (a.requestIds.some(id=>b.requestIds.includes(id))) continue;
      if (++attempted>maxPairs) fail('limite coppie raggiunto: nessun risultato parziale');
      const approach=await cachedMovement(base,a.from,'avvicinamento');
      const transfer=await cachedMovement(a.to,b.from,'trasferimento');
      const ret=await cachedMovement(b.to,base,'ritorno');
      if (a.arrival+transfer.seconds*1000>b.departure) continue;
      const busyStart=a.departure-approach.seconds*1000;
      const busyEnd=b.arrival+ret.seconds*1000;
      if (busyStart<=now || !(await isAvailable(v,busyStart,busyEnd)) ||
          (await hasConflicts(v,busyStart,busyEnd))) continue;
      const waitingHours=(b.departure-a.arrival-transfer.seconds*1000)/3600000;
      const economia=valutaEconomiaCiclo({
        ricaviRichiesteEuro:[...a.prices,...b.prices],
        kmAvvicinamento:approach.metres/1000,
        kmMissioni:a.kmMissione+b.kmMissione,
        kmTrasferimenti:transfer.metres/1000,
        kmRitornoBase:ret.metres/1000,
        euroKm,oreAttesa:waitingHours,costoAttesaOraEuro
      });
      results.push({veicolo:Number(v.id),richieste:[...a.requestIds,...b.requestIds],
        partenza_base:busyStart,ritorno_base:busyEnd,
        margine_ciclo_con_attesa_euro:economia.margineEuro,
        _economiaRicalcolata:true,
        _pixelOpportunitaIds:[Number(a.pixelOpportunitaId),Number(b.pixelOpportunitaId)],
        _shadow:{missions:[a,b],approach,transfer,returnTrip:ret,economia,waitingHours}});
    }
  }
  return {shadow:true,dbWrites:0,attempted,cicli:results,routingStats};
}
