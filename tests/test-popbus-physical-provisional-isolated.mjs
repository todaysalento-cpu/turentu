import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';
import { leggiRegistroAr } from '../services/popbus/v2/pixel-ar-registry.js';
import { generaFormazioniArSafe } from '../services/popbus/v2/pixel-ar-safe-formations.js';
import { generaFormazioniAlternative, valutaRichieste, verificaQualitaRichieste } from '../services/popbus/v2/model.js';
import { preparaAlternativeFisicheFormazione } from '../services/popbus/v2/popbus-pixel-physical-candidates.service.js';

const OPPORTUNITA = 322;
const MAX_FORMAZIONI_TEST = 3;
const client = await pool.connect();
let errore = null;
try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const contesti = await leggiContestiOpportunitaPixel({client, opportunityIds:[OPPORTUNITA], limit:2});
  assert.equal(contesti.length, 1, 'Opportunita 322 assente o non candidata');
  const ctx = contesti[0];
  const registro = await leggiRegistroAr({client, richiestaIds:ctx.richiesta_ids});
  const departureWindow = {start:ctx.window.start, end:ctx.window.end};
  const {formazioni, diagnostica} = generaFormazioniArSafe({
    plan:ctx.plan, requests:ctx.requests, seeds:ctx.richiesta_ids, registro,
    generaFormazioniAlternative:(plan,requests,seeds,options={}) =>
      generaFormazioniAlternative(plan,requests,seeds,{...options,departureWindow}),
    valutaRichieste:(plan,requests,seeds,options={}) =>
      valutaRichieste(plan,requests,seeds,{...options,departureWindow}),
    maxSeeds:100, maxFormazioni:120
  });
  console.log('PIXEL', JSON.stringify({opportunita:OPPORTUNITA, engineId:ctx.engine_id,
    versione:ctx.versione, richieste:ctx.richiesta_ids, formazioni:formazioni.length,
    finestra:{start:new Date(ctx.window.start).toISOString(),end:new Date(ctx.window.end).toISOString()},
    diagnostica},null,2));
  assert.ok(formazioni.length>0,'Nessuna formazione PIXEL');
  const {rows:veicoli} = await client.query(
    "SELECT id,posti_totali FROM veicolo WHERE posti_totali>0 AND driver_id IS NOT NULL ORDER BY posti_totali DESC,id LIMIT 1"
  );
  assert.ok(veicoli.length,'Nessun veicolo con capienza valida');
  const postiTotali=Number(veicoli[0].posti_totali);
  console.log('CAPIENZA DI RIFERIMENTO', JSON.stringify({veicoloId:veicoli[0].id,postiTotali}));
  let tentativi=0, alternative=0, errori=0;
  const now=Date.now();
  for(const evaluation of formazioni){
    if(tentativi>=MAX_FORMAZIONI_TEST) break;
    const selected=ctx.requests.filter(r=>evaluation.requests.some(ref=>Number(ref.id)===Number(r.id)));
    if(selected.length!==evaluation.requests.length ||
       !Number.isFinite(evaluation.departure) || evaluation.departure<=now ||
       evaluation.departure<ctx.window.start || evaluation.departure>ctx.window.end ||
       !Number.isFinite(evaluation.arrival) || evaluation.arrival<=evaluation.departure ||
       !verificaQualitaRichieste(ctx.plan,selected).ok ||
       selected.some(r=>r.stato!=='in_attesa'||r.corsa_id!=null||
         !Number.isSafeInteger(Number(r.posti_richiesti))||Number(r.posti_richiesti)<1) ||
       Number(evaluation.peak)>postiTotali) continue;
    const missionePixel={pixelOpportunitaId:Number(ctx.pixel_opportunita_id),
      pixelDirettriceId:Number(ctx.pixel_direttrice_id),pixelVersione:Number(ctx.versione),
      corridoioPixelId:ctx.engine_id,plan:ctx.plan,evaluation,
      departure:Number(evaluation.departure)};
    tentativi++;
    const ids=evaluation.requests.map(r=>Number(r.id));
    console.log('TENTATIVO',tentativi,'RICHIESTE',JSON.stringify(ids));
    try {
      const result=await preparaAlternativeFisicheFormazione({
        client,missionePixel,richieste:selected,postiTotali
      });
      const count=result.alternativeFisiche.length;
      alternative+=count;
      console.log('RISULTATO',JSON.stringify({ok:result.ok,motivo:result.motivo??null,
        alternativeFisiche:count,diagnostica:result.diagnostica??null},null,2));
      for(const a of result.alternativeFisiche.slice(0,2))
        console.log('ALTERNATIVA',JSON.stringify({nodiFisici:a.nodiFisici,
          nodes:a.missione?.nodes,departure:a.missione?.departure,
          arrival:a.missione?.arrival,richieste:a.missione?.requests},null,2));
    } catch(e) {
      errori++;
      console.error('ERRORE FISICO',e.stack??e.message);
    }
  }
  console.log('RIEPILOGO',JSON.stringify({formazioniGenerate:formazioni.length,
    tentativi,alternativeFisiche:alternative,errori,nessunaScrittura:true,
    attivabile:false}));
  assert.ok(tentativi>0,'Nessuna formazione idonea al test fisico');
  assert.equal(errori,0,'Il bridge ha prodotto errori tecnici');
} catch(e) {
  errore=e;
  console.error('TEST FALLITO:',e.stack??e.message);
} finally {
  try { await client.query('ROLLBACK'); } catch(e) { console.error('ROLLBACK:',e.message); errore??=e; }
  client.release();
  await pool.end();
}
if(errore) process.exitCode=1;
