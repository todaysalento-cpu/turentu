// TURENTU POPBUS V2 - Bridge PIXEL -> alternative fisiche (SHADOW).
// Nessuna persistenza, nessuna scelta finale di veicolo, nessuna attivazione.
import { cercaFermateCandidate } from './popbus-stop-candidates.service.js';
import { generaAssegnazioniFermate } from './popbus-stop-assignment.service.js';
import { valutaCombinazioniFermate } from './popbus-stop-evaluator.service.js';
import { adattaMissioneFermate } from './popbus-stop-mission-adapter.service.js';

const fail = message => { throw new Error(`POPBUS_PIXEL_STOP_BRIDGE: ${message}`); };
const id = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;
const validLimit = (x, max) => Number.isSafeInteger(x) && x >= 1 && x <= max;

export async function generaAlternativeFisichePixelShadow({
  client, formazione, richieste, postiTotali,
  // Accepted for backwards compatibility, but not used to exclude stops.
  tipoVeicolo: _tipoVeicolo = 'ncc',
  raggioMetri = 1500, limiteFermate = 5, maxCombinazioni = 100,
  maxEspansioni = 20000, maxValutazioni = 100, routing,
  // Dipendenze iniettabili esclusivamente per test shadow senza DB/routing.
  servizi = {}
} = {}) {
  if (!client || typeof client.query !== 'function') fail('client di sola lettura obbligatorio');
  if (!formazione || !id(formazione.pixelOpportunitaId) ||
      !id(formazione.pixelDirettriceId) || !id(formazione.pixelVersione) ||
      !Array.isArray(formazione.nodiTerritoriali) ||
      formazione.nodiTerritoriali.length < 2 ||
      formazione.nodiTerritoriali.some(n => !id(n)) ||
      !Array.isArray(formazione.evaluation?.requests) ||
      !formazione.evaluation.requests.length ||
      !Number.isFinite(formazione.departure) ||
      typeof formazione.corridoioPixelId !== 'string' ||
      !formazione.corridoioPixelId.trim()) fail('formazione PIXEL non valida');
  if (!Number.isSafeInteger(postiTotali) || postiTotali < 1) fail('capienza non valida');
  if (!Array.isArray(richieste) || !richieste.length) fail('catalogo richieste non valido');
  if (!validLimit(limiteFermate, 30) || !validLimit(maxCombinazioni, 1000) ||
      !validLimit(maxValutazioni, 1000) || !validLimit(maxEspansioni, 1000000))
    fail('budget non valido');
  const refs = formazione.evaluation.requests;
  const ids = refs.map(r => Number(r.id));
  if (ids.some(x => !id(x)) || new Set(ids).size !== ids.length) fail('richieste PIXEL duplicate/invalide');
  const catalogo = new Map();
  for (const r of richieste) {
    if (!id(r?.id) || catalogo.has(Number(r.id)) ||
        !Number.isSafeInteger(Number(r.posti_richiesti)) || Number(r.posti_richiesti) < 1)
      fail('catalogo richieste duplicato/invalido');
    catalogo.set(Number(r.id), r);
  }
  if (catalogo.size !== ids.length || ids.some(x => !catalogo.has(x)))
    fail('richieste non corrispondenti alla formazione');
  for (const r of refs) {
    if (!Number.isSafeInteger(Number(r.start)) || !Number.isSafeInteger(Number(r.end)) ||
        Number(r.start) < 0 || Number(r.end) <= Number(r.start) ||
        Number(r.end) >= formazione.nodiTerritoriali.length) fail('indici PIXEL non validi');
  }
  const find = servizi.cercaFermateCandidate ?? cercaFermateCandidate;
  const assign = servizi.generaAssegnazioniFermate ?? generaAssegnazioniFermate;
  const evaluate = servizi.valutaCombinazioniFermate ?? valutaCombinazioniFermate;
  const adapt = servizi.adattaMissioneFermate ?? adattaMissioneFermate;
  const candidati = await find({client, richiestaIds:ids, raggioMetri, limite:limiteFermate});
  const assegnazioni = assign({
    evaluation:formazione.evaluation,
    candidati,
    maxCombinazioni,
    maxEspansioni
  });
  const base = {
    pixelOpportunitaId:Number(formazione.pixelOpportunitaId),
    pixelDirettriceId:Number(formazione.pixelDirettriceId),
    pixelVersione:Number(formazione.pixelVersione),
    corridoioPixelId:formazione.corridoioPixelId,
    nodiTerritoriali:formazione.nodiTerritoriali.map(Number),
    richiestaIds:ids, attivabile:false
  };
  if (!assegnazioni.ok) {
    // Solo gli scarti strutturali prima della beam search sono conclusivi.
    // Qualunque motivo sconosciuto o interruzione di budget resta fail-closed.
    const assenzaFermateConclusiva =
      ['FERMATE_COMPATIBILI_ASSENTI', 'NESSUNA_COPPIA_FERMATE'].includes(assegnazioni.motivo);
    const ricercaEsaustiva = assenzaFermateConclusiva &&
      assegnazioni.diagnostica?.ricercaEsaustiva !== false;
    return {...base, ok:false, motivo:assegnazioni.motivo,
      alternativeFisiche:[], diagnostica:{
        assegnazioni:assegnazioni.diagnostica ?? null,
        ricercaEsaustiva,
        fase:'ASSEGNAZIONE_FERMATE',
        assenzaFermateConclusiva
      }};
  }
  if (!assegnazioni.combinazioni?.length) fail('assegnazioni senza combinazioni');
  const valutazione = await evaluate({combinazioni:assegnazioni.combinazioni,
    richieste,postiTotali,departure:formazione.departure,maxValutazioni,
    ...(routing ? {routing} : {})});
  if (!valutazione?.ok || !Array.isArray(valutazione.valide)) fail('valutazione fisica non valida');
  const alternativeFisiche = valutazione.valide.map(alternativa => {
    const adapted = adapt({alternativa,richieste,corridorId:base.corridoioPixelId});
    if (!adapted?.ok || !adapted.missione || !Array.isArray(adapted.missione.requests))
      fail('missione fisica non adattata');
    const got = adapted.missione.requests.map(r => Number(r.id));
    if (got.length !== ids.length || new Set(got).size !== ids.length ||
        got.some(x => !catalogo.has(x))) fail('mapping richieste fisiche discordante');
    return {indice:alternativa.indice,missione:adapted.missione,nodiFisici:adapted.nodi,
      alternativa,kmMissione:alternativa.kmMissione,attivabile:false};
  });
  return {...base,ok:true,stato:'SHADOW_FERMATE_FISICHE',alternativeFisiche,
    diagnostica:{assegnazioni:assegnazioni.diagnostica ?? null,
      valutazione:valutazione.diagnostica ?? null,
      scartiValutazione:valutazione.scartate ?? [],
      ricercaEsaustiva:assegnazioni.diagnostica?.ricercaEsaustiva === true &&
        valutazione.diagnostica?.valutazioneCompleta === true}};
}
