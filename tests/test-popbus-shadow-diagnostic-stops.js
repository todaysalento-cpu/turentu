// Eseguire solo localmente per il collaudo; non importare da worker o route.
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { bridgeFermateDiagnostiche } from '../services/popbus/v2/popbus-shadow-diagnostic-stops.service.js';

if (process.env.POPBUS_SHADOW_DIAGNOSTIC_STOPS !== '1')
  throw new Error('Impostare POPBUS_SHADOW_DIAGNOSTIC_STOPS=1');
try {
  const r=await processaPixelFirstMultimissione({
    pool, mode:'ROLLBACK_ONLY', physicalShadow:true,
    physicalShadowBridge:bridgeFermateDiagnostiche
  });
  console.log('RISULTATO_SHADOW_DIAGNOSTICO',JSON.stringify({
    percorso:r.percorso,missioniCandidateFisiche:r.missioniCandidateFisiche,
    diagnostica:r.diagnostica,dbWrites:r.dbWrites,attivabile:r.attivabile,
    candidati:r.candidati?.map(c=>({vehicleId:c.vehicleId,
      pixelOpportunitaId:c.pixelOpportunitaId,richieste:c.requests?.map(x=>x.id),
      kmMissione:c.kmMissione,partenza:c.departure,arrivo:c.arrival}))
  },null,2));
} catch(e) {console.error('ERRORE_SHADOW',e.stack||e);process.exitCode=1;}
finally {await pool.end();}
