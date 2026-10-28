// TURENTU POPBUS V2 â€” adattamento fail-closed delle alternative fisiche
// Preparazione candidati per pixel-multimission-shadow.js.
// Non effettua scritture DB, non certifica LIVE, non sostituisce il lock transazionale.
import { preparaAlternativeFisicheFormazione } from './popbus-pixel-physical-candidates.service.js';

const fail = message => { throw new Error(`POPBUS_PHYSICAL_MULTI: ${message}`); };
const pos = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
function convertiAlternativa({originale, alternativa, veicolo, richiesteById}) {
  const m = alternativa?.missione;
  if (!m || !Array.isArray(m.nodes) || m.nodes.length < 2 ||
      !Array.isArray(m.legs) || m.legs.length !== m.nodes.length - 1 ||
      !Array.isArray(m.requests) || !m.requests.length ||
      !finite(m.departure) || !finite(m.arrival) || m.arrival <= m.departure)
    fail('missione fisica incompleta');
  if (typeof originale.corridoioPixelId !== 'string' || !originale.corridoioPixelId.trim())
    fail('engine_id PIXEL autorevole mancante');
  const stops = new Map();
  for (const n of alternativa.nodiFisici ?? []) {
    if (!pos(n.id) || !finite(Number(n.lat)) || !finite(Number(n.lon)))
      fail('fermata fisica non valida');
    stops.set(Number(n.id), n);
  }
  const from = stops.get(Number(m.nodes[0]));
  const to = stops.get(Number(m.nodes.at(-1)));
  if (!from || !to) fail('estremi fisici non censiti');
  const ids = originale.evaluation.requests.map(r => Number(r.id));
  const refs = m.requests.map(r => Number(r.id));
  if (ids.length !== refs.length || new Set(refs).size !== refs.length ||
      ids.some(id => !refs.includes(id))) fail('richieste fisiche divergenti');
  const requests = m.requests.map(ref => {
    const r = richiesteById.get(Number(ref.id));
    if (!r || !pos(ref.start + 1) || !pos(ref.end + 1) ||
        ref.start >= ref.end || ref.end >= m.nodes.length ||
        !pos(r.posti_richiesti) || !finite(Number(r.prezzo)))
      fail(`richiesta fisica non valida: ${ref.id}`);
    return {id:Number(ref.id), prezzo:Number(r.prezzo)};
  });
  const kmMissione = m.legs.reduce((sum, leg) => {
    if (!finite(Number(leg.metres)) || Number(leg.metres) < 0 ||
        !finite(Number(leg.seconds)) || Number(leg.seconds) < 0)
      fail('segmento fisico non valido');
    return sum + Number(leg.metres) / 1000;
  }, 0);
  const events = Array(m.nodes.length).fill(0);
  for (const ref of m.requests) {
    const r = richiesteById.get(Number(ref.id));
    events[ref.start] += Number(r.posti_richiesti);
    events[ref.end] -= Number(r.posti_richiesti);
  }
  let onboard = 0, peak = 0;
  for (const delta of events) {
    onboard += delta;
    if (onboard < 0) fail('occupazione negativa');
    peak = Math.max(peak, onboard);
  }
  if (onboard !== 0 || peak > Number(veicolo.posti_totali))
    fail('capienza fisica non valida');
  return {
    pixelOpportunitaId:Number(originale.pixelOpportunitaId),
    pixelDirettriceId:Number(originale.pixelDirettriceId),
    pixelVersione:Number(originale.pixelVersione),
    corridoioPixelId:originale.corridoioPixelId,
    nodiTerritoriali:[...originale.plan.nodes],
    vehicleId:Number(veicolo.id),
    from:{lat:Number(from.lat),lon:Number(from.lon)},
    to:{lat:Number(to.lat),lon:Number(to.lon)},
    departure:m.departure, arrival:m.arrival,
    kmMissione, peak, requests,
    plan:{nodes:[...m.nodes],legs:m.legs},
    evaluation:{requests:m.requests.map(r=>({...r}))},
    nodiFisici:alternativa.nodiFisici,
    validazioneFisica:alternativa.alternativa,
    schemaVersion:2,tipoItinerario:'FERMATE_FISICHE',
    attivabile:false
  };
}

export async function preparaCandidatiFisiciMultimissione({
  client, snapshot, maxTentativi=250, routing, bridge
}={}) {
  if (!client || typeof client.query !== 'function' ||
      !Array.isArray(snapshot?.missioni) || !Array.isArray(snapshot?.contexts) ||
      !Array.isArray(snapshot?.vehicles)) fail('snapshot o client non valido');
  if (!Number.isSafeInteger(maxTentativi) || maxTentativi < 1)
    fail('budget non valido');
  const richiesteById = new Map();
  for (const ctx of snapshot.contexts) for (const r of ctx.requests ?? []) {
    const old = richiesteById.get(Number(r.id));
    if (old && JSON.stringify(old) !== JSON.stringify(r))
      fail(`richiesta ${r.id} incoerente fra opportunita PIXEL`);
    richiesteById.set(Number(r.id), r);
  }
  const diagnosticaLimitata = process.env.POPBUS_PHYSICAL_DIAGNOSTIC_LIMIT != null;
  const limiteDiagnostico = diagnosticaLimitata ? Number(process.env.POPBUS_PHYSICAL_DIAGNOSTIC_LIMIT) : null;
  if (diagnosticaLimitata && (!Number.isSafeInteger(limiteDiagnostico) || limiteDiagnostico < 1 || limiteDiagnostico > maxTentativi))
    fail('POPBUS_PHYSICAL_DIAGNOSTIC_LIMIT non valido');
  const limiteEffettivo = diagnosticaLimitata ? limiteDiagnostico : maxTentativi;
  // Opt-in esclusivamente per benchmark SHADOW: nessuna modifica allo snapshot o al DB.
  const escludiVeicoliTest = process.env.POPBUS_SHADOW_EXCLUDE_TEST_VEHICLES === '1';
  const veicoliEsclusi = [];
  const veicoliValutabili = [];
  for (const v of snapshot.vehicles) {
    if (!pos(v.id) || !pos(v.posti_totali)) fail('veicolo non valido');
    const tipoRaw = String(v.tipo_veicolo ?? '').trim().toLowerCase();
    if (tipoRaw === 'test' && escludiVeicoliTest) {
      veicoliEsclusi.push({vehicleId:Number(v.id),motivo:'VEICOLO_TEST'});
      continue;
    }
    // Il tipo veicolo non è un criterio di compatibilità fermata in questa fase.
    // L'eventuale esclusione opt-in dei veicoli test resta una regola diagnostica separata.
    veicoliValutabili.push(v);
  }
  if (escludiVeicoliTest && veicoliValutabili.length === 0)
    fail('benchmark SHADOW senza veicoli valutabili dopo esclusione test');
  const candidati = [];
  const debugMissioni = process.env.POPBUS_SHADOW_DEBUG_PHYSICAL_MISSIONS === '1';
  // Contiamo le combinazioni eleggibili prima di applicare il budget.
  // Il numero non certifica l'esaustivita della ricerca interna alle fermate.
  const combinazioniElegibili = snapshot.missioni.reduce((tot, m) =>
    tot + veicoliValutabili.filter(v => Number(m.peak) <= Number(v.posti_totali)).length, 0);
  const chiaviFisicheNecessarie = snapshot.missioni.reduce((tot, m) =>
    tot + new Set(veicoliValutabili.filter(v => Number(m.peak) <= Number(v.posti_totali)).map(v => Number(v.posti_totali))).size, 0);
  console.log('[POPBUS PHYSICAL CACHE CAPACITY]', {
    combinazioniElegibili, chiaviFisicheNecessarie,
    riusiTeorici: combinazioniElegibili - chiaviFisicheNecessarie
  });
  // Cache limitata a questa singola esecuzione: non persiste e non attraversa snapshot.
  // La chiave include identità della formazione e capienza.
  // Il tipo veicolo non partecipa alla compatibilità delle fermate in questa fase.
  // Il bridge riceve questi parametri, non l'identita del singolo veicolo.
  const cacheFisica = new Map();
  // Opt-in diagnostico: permette il confronto dello stesso snapshot con/senza cache.
  const disabilitaCacheFisica = process.env.POPBUS_SHADOW_DISABLE_PHYSICAL_CACHE === '1';
  const diagnostica = {tentativi:0,alternative:0,scarti:[],completo:true,attivabile:false,
    diagnosticaLimitata,limiteEffettivo,combinazioniElegibili,
    combinazioniResidue:combinazioniElegibili,
    ricercaInternaNonEsaustiva:0,
    interrottoPerBudget:false,
    calcoliFisici:0,cacheHits:0,cacheEntries:0,tempoCalcoliFisiciMs:0,
    disabilitaCacheFisica,
    escludiVeicoliTest,veicoliEsclusi,numeroVeicoliEsclusi:veicoliEsclusi.length,
    numeroVeicoliValutabili:veicoliValutabili.length,
    esitiFisiciVuoti:0,scartiValutazioneTotali:0,scartiValutazionePerFase:{},
    campioneScartiValutazione:[],
departureShadow: {
  analizzate: 0,
  recuperabiliTemporalmente: 0,
  recuperabiliConQualita: 0,
  senzaIntersezione: 0,
  errori: 0,
  recuperateValidate: 0,
  recuperiRifiutati: 0,

  recuperiRifiutatiRoutingCapienza: 0,
  recuperiRifiutatiTemporale: 0,
  recuperiRifiutatiQualita: 0,
  recuperiRifiutatiErrore: 0
},
    sequenziamento:{sequenzeScartateEventi:0,sequenzeScartateRouting:0,
      routingEccezioni:0,routingRisposteNonValide:0,routingTratteDistinte:0,
      campioneErroriRouting:[]}};
  // Mission-first: le valutazioni della stessa missione vengono confrontate
  // sui veicoli prima di passare alla missione successiva.
  // In diagnostica limitata cambia l'ordine del campione, NON i vincoli.
  const gruppiMissioni = new Map();
  for (const m of snapshot.missioni) {
    const id = Number(m.pixelOpportunitaId);
    if (!Number.isSafeInteger(id) || id <= 0) fail('opportunita PIXEL non valida');
    if (!gruppiMissioni.has(id)) gruppiMissioni.set(id, []);
    gruppiMissioni.get(id).push(m);
  }
  const missioniBilanciate = [];
  const gruppi = [...gruppiMissioni.values()];
  const maxFormazioni = Math.max(0, ...gruppi.map(g => g.length));
  for (let i = 0; i < maxFormazioni; i++) {
    for (const gruppo of gruppi) {
      if (i < gruppo.length) missioniBilanciate.push(gruppo[i]);
    }
  }
  if (missioniBilanciate.length !== snapshot.missioni.length)
    fail('ordinamento missioni incompleto');
  for (const [indiceMissione, m] of missioniBilanciate.entries()) {
    for (const v of veicoliValutabili) {
      if (Number(m.peak) > Number(v.posti_totali)) continue;
      if (diagnostica.tentativi >= limiteEffettivo) {
        if (!diagnosticaLimitata)
          fail('budget combinazioni superato: nessun risultato parziale');
        diagnostica.completo = false;
        diagnostica.interrottoPerBudget = true;
        diagnostica.combinazioniResidue = combinazioniElegibili - diagnostica.tentativi;
        return {candidati,diagnostica,attivabile:false,parziale:true};
      }
      diagnostica.tentativi++;
      diagnostica.combinazioniResidue = combinazioniElegibili - diagnostica.tentativi;
      const richieste = m.evaluation.requests.map(ref => richiesteById.get(Number(ref.id)));
      if (richieste.some(r => !r)) fail('catalogo richieste incompleto');
      // Diagnostica sola lettura: non inventa o sostituisce engine_id PIXEL.
      if (typeof m.corridoioPixelId !== 'string' || !m.corridoioPixelId.trim()) {
        console.error('[PIXEL ENGINE ID DEBUG]', {
          opportunitaId: m.pixelOpportunitaId,
          direttriceId: m.pixelDirettriceId,
          corridoioPixelId: m.corridoioPixelId ?? null,
          tipo: typeof m.corridoioPixelId,
          planNodes: m.plan?.nodes ?? null,
          chiaviMissione: Object.keys(m).sort()
        });
        fail(`engine_id PIXEL autorevole assente: opportunita=${m.pixelOpportunitaId}, direttrice=${m.pixelDirettriceId}`);
      }
      // Identita per indice: evita di confondere formazioni con stessi ID ma
      // valutazioni/orari differenti. Capienza e tipo restano nella chiave.
      const cacheKey = `${indiceMissione}|${Number(v.posti_totali)}`;
      let result;
      if (!disabilitaCacheFisica && cacheFisica.has(cacheKey)) {
        result = cacheFisica.get(cacheKey);
        diagnostica.cacheHits++;
      } else {
        const started = process.hrtime.bigint();
        // Diagnostica temporanea SHADOW: osserva la missione realmente passata all'adapter.
        // Non modifica dati, identita PIXEL, routing o criteri di selezione.
        if (debugMissioni) console.log('[DEBUG PHYSICAL PIXEL MISSION]', {
          opportunitaId: m?.pixelOpportunitaId,
          direttriceId: m?.pixelDirettriceId,
          versione: m?.pixelVersione,
          corridoioPixelId: m?.corridoioPixelId,
          tipoCorridoio: typeof m?.corridoioPixelId,
          chiaviMissione: Object.keys(m ?? {}).sort(),
          veicoloId: Number(v.id),
          richiestaIds: m?.evaluation?.requests?.map(r => Number(r.id)) ?? []
        });
        result = await preparaAlternativeFisicheFormazione({
          client, missionePixel:m, richieste,
          postiTotali:Number(v.posti_totali),
          ...(routing ? {routing} : {}),
          ...(bridge ? {bridge} : {})
        });
        diagnostica.tempoCalcoliFisiciMs += Number(process.hrtime.bigint() - started) / 1e6;
        diagnostica.calcoliFisici++;
// Aggregazione diagnostica SHADOW: una volta per calcolo fisico reale.
const departure =
  result?.diagnostica?.valutazione?.departureShadow ?? null;

if (departure) {
  for (const campo of Object.keys(diagnostica.departureShadow)) {
    const valore = Number(departure[campo] ?? 0);

    if (!Number.isFinite(valore) || valore < 0) {
      fail(`departureShadow non valido: ${campo}`);
    }

    diagnostica.departureShadow[campo] += valore;
  }
}
        // Riepilogo diagnostico una sola volta per calcolo fisico reale.
        const scartiInterni = result?.diagnostica?.scartiValutazione;
        if (Array.isArray(scartiInterni)) {
          diagnostica.scartiValutazioneTotali += scartiInterni.length;
          for (const s of scartiInterni) {
            const fase = String(s?.fase ?? 'SCONOSCIUTA');
            const sd = s?.diagnosticaSequenziamento;
            if (sd && typeof sd === 'object') {
              for (const campo of ['sequenzeScartateEventi','sequenzeScartateRouting',
                'routingEccezioni','routingRisposteNonValide','routingTratteDistinte']) {
                diagnostica.sequenziamento[campo] += Number(sd[campo] ?? 0);
              }
              for (const errore of (sd.campioneErroriRouting ?? [])) {
                if (diagnostica.sequenziamento.campioneErroriRouting.length >= 10) break;
                diagnostica.sequenziamento.campioneErroriRouting.push({
                  opportunitaId:Number(m.pixelOpportunitaId),
                  veicoloId:Number(v.id),...errore
                });
              }
            }
            diagnostica.scartiValutazionePerFase[fase] =
              (diagnostica.scartiValutazionePerFase[fase] ?? 0) + 1;
            if (diagnostica.campioneScartiValutazione.length < 15)
              diagnostica.campioneScartiValutazione.push({
                opportunitaId:Number(m.pixelOpportunitaId),
                veicoloId:Number(v.id), fase, motivo:s?.motivo ?? null,
                richiestaId:s?.richiestaId ?? null
              });
          }
        }
        // Memorizza solo risultati completati (positivi o negativi).
        // Le eccezioni non vengono memorizzate e continuano a interrompere il test.
        if (!disabilitaCacheFisica) {
          cacheFisica.set(cacheKey, result);
          diagnostica.cacheEntries = cacheFisica.size;
        }
      }
      if (result.ok && result.alternativeFisiche?.length === 0)
        diagnostica.esitiFisiciVuoti++;
      if (!result.ok) {
        // L'assenza di alternative e' certificabile solo se la ricerca
        // delle assegnazioni non e' stata interrotta dal budget.
        // Il bridge certifica anche gli scarti strutturali prima della beam search.
        // Non inferire completezza da assegnazioni=null o dal solo motivo testuale.
        if (result.diagnostica?.ricercaEsaustiva !== true) {
          diagnostica.completo = false;
          diagnostica.ricercaInternaNonEsaustiva++;
        }
        diagnostica.scarti.push({veicoloId:Number(v.id),
          opportunitaId:Number(m.pixelOpportunitaId),motivo:result.motivo,
          diagnostica:result.diagnostica??null});
        continue;
      }
      if (result.diagnostica?.ricercaEsaustiva !== true) {
        diagnostica.completo = false;
        diagnostica.ricercaInternaNonEsaustiva++;
      }
      if (!Array.isArray(result.alternativeFisiche))
        fail('risultato positivo senza elenco alternative fisiche');
      for (const alternativa of result.alternativeFisiche) {
        candidati.push(convertiAlternativa({originale:m,alternativa,
          veicolo:v,richiesteById}));
        diagnostica.alternative++;
      }
    }
  }
  diagnostica.combinazioniResidue = 0;
  return {candidati,diagnostica,attivabile:false};
}
