// TURENTU POPBUS V2 ÔÇö Selettore cicli fisici SHADOW, senza persistenza.
// Installare come services/popbus/v2/popbus-physical-cycle-selector.js
// Richiede candidati da preparaCandidatiFisiciMultimissione e veicoli dallo snapshot.
// Non abilita LIVE. Non certifica rivalidazione transazionale, classe o sicurezza fermate.
import polyline from 'polyline';
import { generaCicliDueMissioniShadow } from './pixel-multimission-shadow.js';
import { valutaEconomiaCiclo } from './cycle-pricing.js';

const fail = m => { throw new Error(`POPBUS_PHYSICAL_CYCLE: ${m}`); };
const validId = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const nonNegative = x => x !== null && x !== undefined && Number.isFinite(Number(x)) && Number(x) >= 0;
const finite = x => x !== null && x !== undefined && Number.isFinite(Number(x));
const point = p => p && finite(p.lat) && finite(p.lon);
const key = p => `${Number(p.lat)},${Number(p.lon)}`;
const idsOf = m => m.requests.map(r => Number(r.id));

// Contratto geometrico V2 per i movimenti di ciclo (singole e coppie).
const radians = n => Number(n) * Math.PI / 180;
function distanceMetres(a,b) {
  const dLat = radians(b[0]-a[0]);
  const dLon = radians(b[1]-a[1]);
  const lat = radians((a[0]+b[0])/2);
  return 6371008.8 * Math.hypot(dLat,dLon*Math.cos(lat));
}
function checkPhysicalRoute(route,from,to) {
  if (typeof route.polyline !== 'string' || !route.polyline)
    fail('routing fisico V2: polyline mancante');
  let pts;
  try { pts = polyline.decode(route.polyline); }
  catch { fail('routing fisico V2: geometria non decodificabile'); }
  if (!Array.isArray(pts) || pts.length < 1 || pts.some(p => !Array.isArray(p) ||
      p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
      Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180))
    fail('routing fisico V2: geometria non valida');
  const start = [Number(from.lat),Number(from.lon)];
  const end = [Number(to.lat),Number(to.lon)];
  if (distanceMetres(pts[0],start) > 250 || distanceMetres(pts.at(-1),end) > 250)
    fail('routing fisico V2: geometria non ancorata agli estremi');
  if (typeof route.roadCoincident !== 'boolean')
    fail('routing fisico V2: roadCoincident mancante');
  const metres = Number(route.metres), seconds = Number(route.seconds);
  if (metres === 0 || seconds === 0) {
    if (metres !== 0 || seconds !== 0 || route.roadCoincident !== true ||
        distanceMetres(start,end) > 250 ||
        pts.some(p => distanceMetres(p,pts[0]) > 0.02))
      fail('routing fisico V2: coincidenza stradale incoerente');
    return {metres,seconds,polyline:pts.length === 1 ? polyline.encode([pts[0],pts[0]]) : route.polyline,roadCoincident:true};
  }
  if (pts.length < 2 || route.roadCoincident !== false)
    fail('routing fisico V2: geometria stradale incoerente');
  return {metres,seconds,polyline:route.polyline,roadCoincident:false};
}


function validateCandidate(m) {
  if (!m || m.tipoItinerario !== 'FERMATE_FISICHE' || m.schemaVersion !== 2 ||
      !validId(m.vehicleId) || !validId(m.pixelOpportunitaId) ||
      !String(m.corridoioPixelId ?? '').trim() || !point(m.from) || !point(m.to) ||
      !finite(m.departure) || !finite(m.arrival) || Number(m.arrival) <= Number(m.departure) ||
      !nonNegative(m.kmMissione) || !nonNegative(m.peak) ||
      !Array.isArray(m.requests) || !m.requests.length ||
      !Array.isArray(m.plan?.nodes) || m.plan.nodes.length < 2 ||
      !Array.isArray(m.plan?.legs) || m.plan.legs.length !== m.plan.nodes.length - 1 ||
      !Array.isArray(m.nodiFisici) || !Array.isArray(m.evaluation?.requests))
    fail('candidato fisico incompleto');
  const ids = idsOf(m);
  if (!ids.every(validId) || new Set(ids).size !== ids.length ||
      m.requests.some(r => !nonNegative(r.prezzo)) ||
      !m.plan.nodes.every(validId) ||
      m.plan.legs.some(l => !nonNegative(l.metres) || !nonNegative(l.seconds)))
    fail('richieste o segmenti fisici non validi');
  const stopIds = new Set(m.nodiFisici.map(s => Number(s.id)));
  if (m.nodiFisici.some(s => !validId(s.id) || !point(s)) ||
      m.plan.nodes.some(id => !stopIds.has(Number(id))))
    fail('fermata non presente nel catalogo fisico del candidato');
  const first = m.nodiFisici.find(s => Number(s.id) === Number(m.plan.nodes[0]));
  const last = m.nodiFisici.find(s => Number(s.id) === Number(m.plan.nodes.at(-1)));
  if (key(first) !== key(m.from) || key(last) !== key(m.to))
    fail('estremi del candidato non corrispondenti alle fermate');
  const refs = m.evaluation.requests;
  if (refs.length !== ids.length || new Set(refs.map(r => Number(r.id))).size !== ids.length ||
      refs.some(r => !ids.includes(Number(r.id)) || !Number.isSafeInteger(Number(r.start)) ||
        !Number.isSafeInteger(Number(r.end)) || Number(r.start) < 0 ||
        Number(r.end) <= Number(r.start) || Number(r.end) >= m.plan.nodes.length))
    fail('valutazione richieste incoerente');
}

function normalizeVehicles(vehicles) {
  const map = new Map();
  for (const v of vehicles) {
    if (!validId(v.id) || !point(v) || !nonNegative(v.euro_km ?? v.euroKm) ||
        !validId(v.posti_totali)) fail('configurazione veicolo non valida');
    const id = Number(v.id);
    const item = {...v, id, euroKm:Number(v.euro_km ?? v.euroKm),
      posti_totali:Number(v.posti_totali), lat:Number(v.lat), lon:Number(v.lon)};
    const existing = map.get(id);
    if (existing && (key(existing) !== key(item) || existing.euroKm !== item.euroKm ||
        existing.posti_totali !== item.posti_totali))
      fail(`configurazioni divergenti per veicolo ${id}`);
    map.set(id,item);
  }
  return map;
}

/**
 * Tutte le callback sono obbligatorie, per non assumere disponibilita o A/R.
 * validatePair(a,b) deve verificare la completezza A/R globale e ulteriori
 * vincoli di classe/qualita non gia certificati dai candidati fisici.
 * movement(from,to) deve restituire routing stradale verificato {metres,seconds}.
 * isAvailable(vehicle,start,end) e hasConflicts(vehicle,start,end) leggono DB.
 * Il chiamante deve usare una transazione READ ONLY e garantire ROLLBACK.
 */
export async function selezionaCicliFisiciShadow({
  candidati, vehicles, movement, isAvailable, hasConflicts, validatePair,
  validateSingle = null,
  now = Date.now(), maxPairs = 100000, maxRoutingCalls = 500,
  costoAttesaOraEuro = 0, altriCostiEuro = 0, margineMinimoEuro = 0,
  maxRisultati = 10, contrattoRoutingFisicoV2 = false
} = {}) {
  if (!Array.isArray(candidati) || !Array.isArray(vehicles) ||
      typeof movement !== 'function' || typeof isAvailable !== 'function' ||
      typeof hasConflicts !== 'function' || typeof validatePair !== 'function' ||
      (validateSingle !== null && typeof validateSingle !== 'function'))
    fail('dipendenze obbligatorie mancanti');
  if (![maxPairs,maxRoutingCalls,maxRisultati].every(validId) ||
      !finite(now) || ![costoAttesaOraEuro,altriCostiEuro,margineMinimoEuro].every(nonNegative))
    fail('parametri di selezione non validi');
  if (typeof contrattoRoutingFisicoV2 !== 'boolean') fail('contrattoRoutingFisicoV2 non valido');
  const vehicleMap = normalizeVehicles(vehicles);
  const groups = new Map();
  for (const c of candidati) {
    validateCandidate(c);
    const v = vehicleMap.get(Number(c.vehicleId));
    if (!v) fail(`veicolo ${c.vehicleId} assente nello snapshot`);
    if (Number(c.peak) > v.posti_totali) fail('capienza fisica incompatibile');
    if (!groups.has(v.id)) groups.set(v.id,[]);
    groups.get(v.id).push(c);
  }
  const diagnostica = {candidati:candidati.length,veicoliConCandidati:groups.size,
    singoleEsaminate:0,singoleScartateOrario:0,singoleScartateVincoli:0,
    singoleScartateOperativita:0,singoleFisicamenteFattibili:0,
    singoleEconomicamenteAmmissibili:0,singoleScartateEconomia:0,
    singoleNonValutateSenzaCallback:validateSingle === null,
    coppieEsaminate:0,coppieTemporali:0,coppieConRichiesteDisgiunte:0,
    coppieAmmesseDaVincoli:0,coppieScartateVincoli:0,
    coppieValutateRouting:0,cicliFisicamenteFattibili:0,
    cicliEconomicamenteAmmissibili:0,cicliScartatiEconomia:0,
    completo:true,attivabile:false,dbWrites:0,
    coppieTeoricheOrdinate:0,coppieStessaAlternativa:0,
    coppieScartatePartenzaNonFutura:0,coppieScartateSovrapposizione:0,
    coppieScartateRichiesteComuni:0,diagnosticaPerVeicolo:[]};
  const pairs=[];
  // Ordinamento deterministico, senza taglio TOP-K prima dell'ottimizzazione.
  for (const [vehicleId, ms] of [...groups.entries()].sort((a,b)=>a[0]-b[0])) {
    const ordered = [...ms].sort((a,b)=>a.departure-b.departure || a.arrival-b.arrival ||
      idsOf(a).join(',').localeCompare(idsOf(b).join(',')));
    const perVeicolo = {vehicleId,alternative:ordered.length,
      coppieTeoricheOrdinate:0,coppieTemporali:0,
      scartiStessaAlternativa:0,scartiPartenzaNonFutura:0,
      scartiSovrapposizione:0,scartiRichiesteComuni:0,
      coppieConRichiesteDisgiunte:0,coppieAmmesseDaVincoli:0,
      coppieScartateVincoli:0};
    diagnostica.diagnosticaPerVeicolo.push(perVeicolo);
    for (const a of ordered) for (const b of ordered) {
      diagnostica.coppieTeoricheOrdinate++;
      perVeicolo.coppieTeoricheOrdinate++;
      if (a === b) {
        diagnostica.coppieStessaAlternativa++;
        perVeicolo.scartiStessaAlternativa++;
        continue;
      }
      if (Number(a.departure) <= Number(now)) {
        diagnostica.coppieScartatePartenzaNonFutura++;
        perVeicolo.scartiPartenzaNonFutura++;
        continue;
      }
      if (Number(a.arrival) > Number(b.departure)) {
        diagnostica.coppieScartateSovrapposizione++;
        perVeicolo.scartiSovrapposizione++;
        continue;
      }
      diagnostica.coppieTemporali++;
      perVeicolo.coppieTemporali++;
      const aa = new Set(idsOf(a));
      if (idsOf(b).some(id=>aa.has(id))) {
        diagnostica.coppieScartateRichiesteComuni++;
        perVeicolo.scartiRichiesteComuni++;
        continue;
      }
      diagnostica.coppieConRichiesteDisgiunte++;
      perVeicolo.coppieConRichiesteDisgiunte++;
      // La callback deve essere pura/read-only; false esclude, non si presume true.
      if (await validatePair(a,b) !== true) {
        diagnostica.coppieScartateVincoli++;
        perVeicolo.coppieScartateVincoli++;
        continue;
      }
      diagnostica.coppieAmmesseDaVincoli++;
      perVeicolo.coppieAmmesseDaVincoli++;
      if (pairs.length >= maxPairs) fail(`budget coppie ${maxPairs} superato: nessun risultato parziale`);
      pairs.push({a,b,vehicle:vehicleMap.get(vehicleId)});
    }
  }
  // Compatibilita con i report precedenti: coppieEsaminate resta il
  // numero di coppie ammesse ai controlli di routing.
  diagnostica.coppieEsaminate = pairs.length;
  // Cache globale fra coppie; la direzione stradale e' parte della chiave.
  const routes = new Map();
  let routingCalls = 0;
  async function cachedMovement(from,to) {
    const k = `${key(from)}>${key(to)}`;
    if (routes.has(k)) return routes.get(k);
    if (++routingCalls > maxRoutingCalls) fail(`budget routing ${maxRoutingCalls} superato: nessun risultato parziale`);
    const route = await movement(from,to);
    if (!route || !nonNegative(route.metres) || !nonNegative(route.seconds))
      fail('routing stradale non valido');
    const checked = contrattoRoutingFisicoV2 ? checkPhysicalRoute(route,from,to) : route;
    routes.set(k,checked);
    return checked;
  }
  const valid = [];
  // Diagnostica economica SHADOW: nessuna variazione ai criteri di ammissione.
  const economica = {
    cicliAnalizzati:0, singoleAnalizzate:0, coppieAnalizzate:0,
    deficitTotaleEuro:0, deficitMinimoEuro:null,
    deficitMassimoEuro:null, margineMiglioreEuro:null,
    esempiMigliori:[], perVeicolo:{}
  };
  const MAX_ESEMPI_ECONOMICI = 10;
  function registraEconomia(economy, vehicle, a, b = null) {
    const deficitCents = Math.max(0, economy.centesimi.sogliaLorda - economy.centesimi.ricavoLordo);
    const deficitEuro = deficitCents / 100;
    const veicoloId = String(vehicle.id);
    const voce = economica.perVeicolo[veicoloId] ?? {
      vehicleId:vehicle.id, cicli:0, deficitMinimoEuro:null,
      margineMiglioreEuro:null
    };
    voce.cicli++;
    voce.deficitMinimoEuro = voce.deficitMinimoEuro === null ? deficitEuro : Math.min(voce.deficitMinimoEuro, deficitEuro);
    voce.margineMiglioreEuro = voce.margineMiglioreEuro === null ? economy.margineEuro : Math.max(voce.margineMiglioreEuro, economy.margineEuro);
    economica.perVeicolo[veicoloId] = voce;
    economica.cicliAnalizzati++;
    if (b) economica.coppieAnalizzate++;
    else economica.singoleAnalizzate++;
    economica.deficitTotaleEuro += deficitEuro;
    economica.deficitMinimoEuro = economica.deficitMinimoEuro === null ? deficitEuro : Math.min(economica.deficitMinimoEuro, deficitEuro);
    economica.deficitMassimoEuro = economica.deficitMassimoEuro === null ? deficitEuro : Math.max(economica.deficitMassimoEuro, deficitEuro);
    economica.margineMiglioreEuro = economica.margineMiglioreEuro === null ? economy.margineEuro : Math.max(economica.margineMiglioreEuro, economy.margineEuro);
    const sample = {
      tipoCiclo:b ? 'COPPIA' : 'SINGOLA',
      vehicleId:vehicle.id, opportunita:b ? [a.pixelOpportunitaId,b.pixelOpportunitaId] : [a.pixelOpportunitaId],
      richiesteA:idsOf(a), richiesteB:b ? idsOf(b) : [],
      euroKm:vehicle.euroKm,
      ricavoLordoEuro:economy.ricavoLordoEuro,
      commissioneTurentuEuro:economy.commissioneTurentuEuro,
      ricavoNettoEuro:economy.ricavoNettoEuro,
      km:economy.km,
      costoKmEuro:economy.costoKmEuro,
      costoAttesaEuro:economy.costoAttesaEuro,
      altriCostiEuro:economy.altriCostiEuro,
      costoCompletoEuro:economy.costoCompletoEuro,
      margineEuro:economy.margineEuro,
      margineMinimoEuro:economy.margineMinimoEuro,
      sogliaAttivazioneLordaEuro:economy.sogliaAttivazioneLordaEuro,
      deficitLordoEuro:deficitEuro,
      economicamenteAttivabile:economy.economicamenteAttivabile
    };
    economica.esempiMigliori.push(sample);
    economica.esempiMigliori.sort((x,y)=>x.deficitLordoEuro-y.deficitLordoEuro || y.ricavoLordoEuro-x.ricavoLordoEuro || x.vehicleId-y.vehicleId);
    if (economica.esempiMigliori.length > MAX_ESEMPI_ECONOMICI) economica.esempiMigliori.length = MAX_ESEMPI_ECONOMICI;
  }
  // Singole SHADOW: nessuna A/R presunta. Senza validateSingle non vengono valutate.
  // La callback deve certificare gli ulteriori vincoli (incluse eventuali A/R).
  if (validateSingle !== null) {
    for (const [vehicleId, ms] of [...groups.entries()].sort((a,b)=>a[0]-b[0])) {
      const vehicle = vehicleMap.get(vehicleId);
      for (const a of ms) {
        diagnostica.singoleEsaminate++;
        if (Number(a.departure) <= Number(now)) {
          diagnostica.singoleScartateOrario++;
          continue;
        }
        if (await validateSingle(a) !== true) {
          diagnostica.singoleScartateVincoli++;
          continue;
        }
        const base = {lat:vehicle.lat,lon:vehicle.lon};
        const approach = await cachedMovement(base,a.from);
        const ret = await cachedMovement(a.to,base);
        const busyStart = Number(a.departure)-Number(approach.seconds)*1000;
        const busyEnd = Number(a.arrival)+Number(ret.seconds)*1000;
        if (busyStart <= Number(now) ||
            !(await isAvailable(vehicle,busyStart,busyEnd)) ||
            (await hasConflicts(vehicle,busyStart,busyEnd))) {
          diagnostica.singoleScartateOperativita++;
          continue;
        }
        diagnostica.singoleFisicamenteFattibili++;
        const economy = valutaEconomiaCiclo({
          ricaviRichiesteEuro:a.requests.map(r=>Number(r.prezzo)),
          kmAvvicinamento:Number(approach.metres)/1000,
          kmMissioni:Number(a.kmMissione),
          kmTrasferimenti:0,
          kmRitornoBase:Number(ret.metres)/1000,
          euroKm:vehicle.euroKm,
          oreAttesa:0,
          costoAttesaOraEuro:Number(costoAttesaOraEuro),
          altriCostiEuro:Number(altriCostiEuro),
          margineMinimoEuro:Number(margineMinimoEuro)
        });
        // Registra anche le singole: il report economico prima copriva solo le coppie.
        // La raccolta diagnostica non modifica l'ammissione economica.
        registraEconomia(economy,vehicle,a);
        if (!economy.economicamenteAttivabile) {
          diagnostica.singoleScartateEconomia++;
          continue;
        }
        diagnostica.singoleEconomicamenteAmmissibili++;
        valid.push({vehicleId:vehicle.id,missioni:[a],richiestaIds:idsOf(a),
          numeroRichieste:idsOf(a).length,partenzaBase:busyStart,
          ritornoBase:busyEnd,economia:economy,attivabile:false,
          ...(contrattoRoutingFisicoV2 ? {routingFisico:{approach,transfer:null,returnTrip:ret,waitingHours:0}} : {})});
      }
    }
  }
  for (const {a,b,vehicle} of pairs) {
    diagnostica.coppieValutateRouting++;
    const result = await generaCicliDueMissioniShadow({
      missions:[a,b],vehicles:[vehicle],movement:cachedMovement,
      isAvailable,hasConflicts,now:Number(now),maxPairs:2,maxRoutingCalls:3,
      costoAttesaOraEuro:Number(costoAttesaOraEuro),
      contrattoRoutingFisicoV2
    });
    for (const c of result.cicli) {
      diagnostica.cicliFisicamenteFattibili++;
      const s = c._shadow;
      const economy = valutaEconomiaCiclo({
        ricaviRichiesteEuro:[...a.requests,...b.requests].map(r=>Number(r.prezzo)),
        kmAvvicinamento:Number(s.approach.metres)/1000,
        kmMissioni:Number(a.kmMissione)+Number(b.kmMissione),
        kmTrasferimenti:Number(s.transfer.metres)/1000,
        kmRitornoBase:Number(s.returnTrip.metres)/1000,
        euroKm:vehicle.euroKm,oreAttesa:s.waitingHours,
        costoAttesaOraEuro:Number(costoAttesaOraEuro),
        altriCostiEuro:Number(altriCostiEuro),margineMinimoEuro:Number(margineMinimoEuro)
      });
      registraEconomia(economy,vehicle,a,b);
      if (!economy.economicamenteAttivabile) {
        diagnostica.cicliScartatiEconomia++;
        continue;
      }
      diagnostica.cicliEconomicamenteAmmissibili++;
      valid.push({vehicleId:vehicle.id,missioni:[a,b],richiestaIds:c.richieste,
        numeroRichieste:c.richieste.length,partenzaBase:c.partenza_base,
        ritornoBase:c.ritorno_base,economia:economy,attivabile:false,
        ...(contrattoRoutingFisicoV2 ? {routingFisico:{approach:s.approach,transfer:s.transfer,
          returnTrip:s.returnTrip,waitingHours:s.waitingHours}} : {})});
    }
  }
  // Ranking SHADOW: singole e coppie nello stesso insieme; prima richieste servite, poi margine; non e' un
  // ottimizzatore globale di flotta e non assegna richieste definitivamente.
  valid.sort((a,b)=>b.numeroRichieste-a.numeroRichieste ||
    b.economia.centesimi.margine-a.economia.centesimi.margine ||
    a.partenzaBase-b.partenzaBase || a.vehicleId-b.vehicleId);
  const diagnosticaEconomica = {
    ...economica,
    deficitMedioEuro:economica.cicliAnalizzati ? Math.round(economica.deficitTotaleEuro / economica.cicliAnalizzati * 100)/100 : null,
    deficitTotaleEuro:Math.round(economica.deficitTotaleEuro*100)/100,
    perVeicolo:Object.values(economica.perVeicolo).sort((a,b)=>a.vehicleId-b.vehicleId)
  };
  return {shadow:true,attivabile:false,dbWrites:0,
    diagnostica:{...diagnostica,chiamateRouting:routingCalls,rotteInCache:routes.size,
      cicliTotaliAmmissibili:valid.length},
    diagnosticaEconomica,
    miglioriCicli:valid.slice(0,maxRisultati),
    migliorCiclo:valid[0] ?? null};
}
