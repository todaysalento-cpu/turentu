// TURENTU POPBUS V2 — Preview multimissione isolata (nessuna scrittura DB).
// Collocazione prevista: services/popbus/v2/formation-multimission-preview.js
// Il chiamante fornisce missioni PIXEL già validate, veicoli e callback operative.
import { generaCicliDueMissioniShadow } from './pixel-multimission-shadow.js';
import { valutaEconomiaCiclo } from './cycle-pricing.js';

const finite = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const nonnegative = x => finite(x) && Number(x) >= 0;
const idOk = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const money = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const fail = msg => { throw new Error(`FORMATION_MULTIMISSION_PREVIEW: ${msg}`); };

function validateMission(m) {
  if (!m || !idOk(m.pixelOpportunitaId) || !Array.isArray(m.requests) || !m.requests.length)
    fail('missione PIXEL non valida');
  if (!finite(m.departure) || !finite(m.arrival) || Number(m.departure) >= Number(m.arrival))
    fail('orari missione non validi');
  if (!nonnegative(m.kmMissione) || !nonnegative(m.peak)) fail('distanza o occupazione non valida');
  if (!m.from || !m.to || ![m.from.lat,m.from.lon,m.to.lat,m.to.lon].every(finite))
    fail('coordinate missione mancanti');
  const ids = m.requests.map(r => r.id);
  if (!ids.every(idOk) || new Set(ids.map(Number)).size !== ids.length ||
      !m.requests.every(r => nonnegative(r.prezzo))) fail('richieste o prezzi non validi');
  if (m.validated !== true) fail('missione priva di attestazione di validazione');
}

function validateVehicle(v) {
  if (!v || !idOk(v.id) || ![v.lat,v.lon,v.euroKm].every(finite) ||
      !nonnegative(v.euroKm) || !Number.isSafeInteger(Number(v.posti_totali)) ||
      Number(v.posti_totali) < 1) fail('veicolo non valido');
}

/**
 * Diagnostica a sola lettura, NON certificazione di attivabilità.
 * missions: missioni PIXEL con validated:true (validazione temporale ai nodi,
 * qualità, capienza, richieste libere e regole A/R eseguita dal chiamante).
 * validatePair(a,b): controllo obbligatorio dei vincoli incrociati A/R e delle
 * eventuali regole di classe; deve restituire true soltanto se la coppia è valida.
 * Le callback movement, isAvailable, hasConflicts devono essere reali e fail-closed.
 * Nessuna selezione TOP-K o filtro di redditività prima del routing.
 */
export async function anteprimaCicliMultimissione({
  missions, vehicles, movement, isAvailable, hasConflicts, validatePair,
  now = Date.now(), maxPairs = 10000, maxRoutingCalls = 100,
  costoAttesaOraEuro = 0, altriCostiEuro = 0, margineMinimoEuro = 0
} = {}) {
  if (!Array.isArray(missions) || !Array.isArray(vehicles) ||
      typeof movement !== 'function' || typeof isAvailable !== 'function' ||
      typeof hasConflicts !== 'function' || typeof validatePair !== 'function')
    fail('dipendenze o validatore di coppia mancanti');
  if (!finite(now) || !Number.isSafeInteger(maxPairs) || maxPairs < 1 ||
      !Number.isSafeInteger(maxRoutingCalls) || maxRoutingCalls < 1 ||
      ![costoAttesaOraEuro, altriCostiEuro, margineMinimoEuro].every(nonnegative))
    fail('parametri di simulazione non validi');
  missions.forEach(validateMission);
  vehicles.forEach(validateVehicle);

  // Il filtro delle coppie è indipendente dall'economia. La duplicazione delle
  // richieste è verificata anche nel generatore Shadow.
  const admissible = [];
  for (let i = 0; i < missions.length; i++) {
    for (let j = 0; j < missions.length; j++) {
      if (i === j) continue;
      const a = missions[i], b = missions[j];
      if (Number(a.arrival) > Number(b.departure) || Number(a.departure) <= Number(now)) continue;
      const ids = [...a.requests, ...b.requests].map(r => Number(r.id));
      if (new Set(ids).size !== ids.length) continue;
      if (await validatePair(a,b) !== true) continue;
      admissible.push([a,b]);
    }
  }

  // Shadow conta coppie per veicolo; falliamo prima di eseguire routing.
  const possible = admissible.reduce((count,[a,b]) => count + vehicles.filter(v =>
    Number(a.peak) <= Number(v.posti_totali) &&
    Number(b.peak) <= Number(v.posti_totali)).length, 0);
  if (possible > maxPairs) fail(`limite coppie superato (${possible} > ${maxPairs}); nessun risultato parziale`);

  const routingCache = new Map();
  let routingCalls = 0;
  const cachedMovement = async (a,b) => {
    const key = `${Number(a.lat)},${Number(a.lon)}>${Number(b.lat)},${Number(b.lon)}`;
    if (routingCache.has(key)) return routingCache.get(key);
    if (++routingCalls > maxRoutingCalls) fail('budget routing esaurito; nessun risultato parziale');
    const result = await movement(a,b);
    if (!result || ![result.metres,result.seconds].every(nonnegative)) fail('routing non valido');
    routingCache.set(key,result);
    return result;
  };
  const cicli = [];
  let attempted = 0;
  for (const [a,b] of admissible) {
    // Due missioni sono passate in ordine; Shadow valuta solo a -> b.
    const out = await generaCicliDueMissioniShadow({
      missions:[a,b], vehicles, movement:cachedMovement, isAvailable,
      hasConflicts, now:Number(now), maxPairs:Math.max(1,vehicles.length),
      maxRoutingCalls:Math.max(1,maxRoutingCalls), costoAttesaOraEuro
    });
    attempted += out.attempted;
    for (const c of out.cicli) {
      const v = vehicles.find(x => Number(x.id) === Number(c.veicolo));
      if (!v) fail('veicolo risultato non trovato');
      const s = c._shadow;
      const economy = valutaEconomiaCiclo({
        ricaviRichiesteEuro:[...a.requests,...b.requests].map(r => Number(r.prezzo)),
        kmAvvicinamento:Number(s.approach.metres)/1000,
        kmMissioni:Number(a.kmMissione)+Number(b.kmMissione),
        kmTrasferimenti:Number(s.transfer.metres)/1000,
        kmRitornoBase:Number(s.returnTrip.metres)/1000,
        euroKm:Number(v.euroKm), oreAttesa:Number(s.waitingHours),
        costoAttesaOraEuro:Number(costoAttesaOraEuro),
        altriCostiEuro:Number(altriCostiEuro), margineMinimoEuro:Number(margineMinimoEuro)
      });
      cicli.push({
        tipo_ciclo:'due_missioni', simulazione_non_prenotabile:true,
        attendibilita:'diagnostica', veicolo_id:Number(v.id),
        pixel_opportunita_ids:[Number(a.pixelOpportunitaId),Number(b.pixelOpportunitaId)],
        richiesta_ids:[...a.requests,...b.requests].map(r => Number(r.id)),
        partenza_base:new Date(c.partenza_base).toISOString(),
        ritorno_base:new Date(c.ritorno_base).toISOString(),
        ricavo_lordo_euro:economy.ricavoLordoEuro,
        costo_completo_euro:economy.costoCompletoEuro,
        soglia_attivazione_lorda_euro:economy.sogliaAttivazioneLordaEuro,
        margine_euro:economy.margineEuro,
        deficit_lordo_euro:money(Math.max(0,economy.sogliaAttivazioneLordaEuro-economy.ricavoLordoEuro)),
        soglia_raggiunta_economicamente:economy.economicamenteAttivabile,
        km_avvicinamento:Number(s.approach.metres)/1000,
        km_missioni:Number(a.kmMissione)+Number(b.kmMissione),
        km_trasferimento:Number(s.transfer.metres)/1000,
        km_ritorno:Number(s.returnTrip.metres)/1000,
        ore_attesa:Number(s.waitingHours)
      });
    }
  }
  cicli.sort((a,b) => a.deficit_lordo_euro-b.deficit_lordo_euro ||
    b.margine_euro-a.margine_euro || a.veicolo_id-b.veicolo_id);
  return {
    shadow:true, dbWrites:0, simulazione_non_prenotabile:true,
    completezza:'limitata_alle_missioni_fornite',
    coppie_ammesse:admissible.length, coppie_valutate:attempted,
    routing_calls:routingCalls, cicli, migliore:cicli[0] ?? null
  };
}
