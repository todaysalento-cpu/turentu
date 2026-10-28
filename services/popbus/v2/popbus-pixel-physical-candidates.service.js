// TURENTU — adattamento read-only delle formazioni PIXEL in alternative fisiche.
// NON autorizza LIVE, non persiste, non sceglie veicoli/cicli.
import { generaAlternativeFisichePixelShadow } from './popbus-pixel-stop-bridge.service.js';

const fail = s => { throw new Error('PIXEL_PHYSICAL_CANDIDATES: ' + s); };
const pos = x => x != null && Number.isSafeInteger(Number(x)) && Number(x)>0;
const sameIds = (a,b) => a.length===b.length &&
  a.every(x=>b.includes(x)) && new Set(a).size===a.length;

export async function preparaAlternativeFisicheFormazione({
  client, missionePixel, richieste, postiTotali, tipoVeicolo='ncc',
  routing, bridge=generaAlternativeFisichePixelShadow
}={}) {
  if (!client || typeof client.query!=='function') fail('client PostgreSQL obbligatorio');
  if (!missionePixel?.evaluation?.requests?.length ||
      !Array.isArray(missionePixel.plan?.nodes) ||
      !pos(missionePixel.pixelOpportunitaId) ||
      !pos(missionePixel.pixelDirettriceId) ||
      !pos(missionePixel.pixelVersione)) fail('missione PIXEL incompleta');
  // Non inventare l'engine_id: deve provenire dalla fonte PIXEL autorevole.
  if (typeof missionePixel.corridoioPixelId!=='string' ||
      !missionePixel.corridoioPixelId.trim())
    fail('engine_id PIXEL autorevole assente');
  if (!Number.isSafeInteger(Number(postiTotali)) || Number(postiTotali)<1)
    fail('capienza non valida');
  const ids=missionePixel.evaluation.requests.map(r=>Number(r.id));
  if (!Array.isArray(richieste) || !sameIds(ids,richieste.map(r=>Number(r.id))))
    fail('catalogo richieste non corrispondente');
  const formazione={
    pixelOpportunitaId:Number(missionePixel.pixelOpportunitaId),
    pixelDirettriceId:Number(missionePixel.pixelDirettriceId),
    pixelVersione:Number(missionePixel.pixelVersione),
    corridoioPixelId:missionePixel.corridoioPixelId,
    nodiTerritoriali:missionePixel.plan.nodes.map(Number),
    evaluation:missionePixel.evaluation,
    departure:Number(missionePixel.departure)
  };
  const result=await bridge({client,formazione,richieste,
    postiTotali:Number(postiTotali),tipoVeicolo,
    ...(routing?{routing}:{})});
  if (!result || typeof result.ok !== 'boolean' ||
      !Array.isArray(result.alternativeFisiche))
    fail('risposta bridge fisico non valida');
  if (!result.ok) {
    if (result.alternativeFisiche.length !== 0)
      fail('bridge negativo con alternative fisiche');
    return {ok:false,alternativeFisiche:[],
      motivo:result.motivo??'NESSUNA_ALTERNATIVA',
      diagnostica:result.diagnostica??null,
      attivabile:false};
  }
  const alternatives=result.alternativeFisiche.map(a=>{
    const m=a?.missione;
    if (!Array.isArray(m?.nodes) || !Array.isArray(m?.legs) ||
        m.legs.length!==m.nodes.length-1 || !Array.isArray(m.requests) ||
        !sameIds(ids,m.requests.map(r=>Number(r.id))) ||
        !Number.isFinite(Number(m.departure)) ||
        !Number.isFinite(Number(m.arrival)) || Number(m.arrival)<=Number(m.departure))
      fail('alternativa fisica malformata');
    return {
      ...a, missione:m,
      pixelOpportunitaId:formazione.pixelOpportunitaId,
      pixelDirettriceId:formazione.pixelDirettriceId,
      pixelVersione:formazione.pixelVersione,
      corridoioPixelId:formazione.corridoioPixelId,
      nodiTerritoriali:[...formazione.nodiTerritoriali],
      attivabile:false
    };
  });
  return {ok:true,alternativeFisiche:alternatives,
    diagnostica:result.diagnostica??null,attivabile:false};
}
