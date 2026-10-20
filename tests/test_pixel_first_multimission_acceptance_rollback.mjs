// C7 — E2E PIXEL-first multimissione: solo fixture wallet esplicitamente autorizzate.
// NON usare su richieste clienti reali. Nessun COMMIT, nessuna chiamata Stripe.
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { accettaAttivazione } from '../services/popbus/v2/acceptance.js';

const assert = (v,m) => { if (!v) throw new Error('C7: '+m); };
assert(process.env.POPBUS_PIXEL_TX_STAGING === 'ROLLBACK_ONLY','impostare POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY');
assert(process.env.POPBUS_PIXEL_FIRST !== '1','POPBUS_PIXEL_FIRST deve restare OFF');
assert(process.env.C7_ISOLATED_FIXTURES_CONFIRMED === 'YES','confermare fixture isolate tramite C7_ISOLATED_FIXTURES_CONFIRMED=YES');
const fixtureIds = String(process.env.C7_FIXTURE_REQUEST_IDS || '').split(',').map(x=>x.trim()).filter(Boolean).map(Number);
assert(fixtureIds.length>=2 && fixtureIds.every(x=>Number.isSafeInteger(x)&&x>0) && new Set(fixtureIds).size===fixtureIds.length,
  'specificare C7_FIXTURE_REQUEST_IDS=id1,id2,... (fixture isolate, non utenti reali)');
assert(!process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED || process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1', 'LIVE deve essere disabilitato');
process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST='true'; // solo processo locale

let observed=null;
try {
  const result=await processaPixelFirstMultimissione({pool,mode:'ROLLBACK_ONLY',rollbackTestHook:async(client,created)=>{
    const ids=created.richiestaIds.map(Number).sort((a,b)=>a-b);
    assert(ids.length===fixtureIds.length && ids.every((id,i)=>id===[...fixtureIds].sort((a,b)=>a-b)[i]),
      'il motore ha scelto richieste diverse dalle fixture autorizzate: test interrotto');
    const {rows:requests}=await client.query(`SELECT id,cliente_id,request_id,prezzo,payment_intent_id,stato
      FROM richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[ids]);
    assert(requests.length===ids.length,'richieste non reperibili');
    assert(requests.every(r=>r.stato==='in_lavorazione' && r.cliente_id && r.request_id &&
      String(r.payment_intent_id).startsWith('wallet_')),
      'fixture non wallet o non valide: vietato interrogare Stripe');
    const {rows:actRows}=await client.query(`SELECT piano FROM popbus_attivazioni WHERE id=$1`,[created.attivazioneId]);
    const plan=actRows[0]?.piano;
    assert(plan?.missioni?.length===2,'non sono state persistite esattamente due missioni');
    const {rows:missionRows}=await client.query(`SELECT count(*)::int AS n FROM popbus_attivazione_missioni WHERE attivazione_id=$1`,[created.attivazioneId]);
    assert(missionRows[0].n===2,'numero missioni DB errato');
    const requestMap=new Map(requests.map(r=>[String(r.request_id),r]));
    let walletChecks=0;
    const walletClient={query:async(sql,params=[])=>{
      const q=String(sql).replace(/\s+/g,' ').trim();
      if (/^SELECT COALESCE\(SUM\(importo\), 0\) AS totale FROM transazioni_wallet WHERE utente_id = \$1 AND riferimento_id::text = \$2$/i.test(q)) {
        const r=requestMap.get(String(params[1]));
        assert(r && Number(r.cliente_id)===Number(params[0]),'identita wallet non coerente');
        walletChecks++;
        return {rows:[{totale:String(-Number(r.prezzo))}],rowCount:1};
      }
      assert(!/transazioni_wallet/i.test(q),'query wallet non riconosciuta');
      return client.query(sql,params);
    }};
    const ride=await accettaAttivazione(walletClient,created.offertaId,created.autistaId);
    assert(ride?.id,'acceptance non ha generato corsa');
    assert(walletChecks===ids.length,'verifiche wallet incomplete');
    const {rows:[counts]}=await client.query(`SELECT
      (SELECT count(*)::int FROM corse WHERE id=$1) AS corse,
      (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$1) AS prenotazioni,
      (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$1) AS pagamenti,
      (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($2::int[]) AND stato='convertita' AND corsa_id=$1) AS convertite,
      (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$3 AND stato='confermata' AND corsa_id=$1) AS confermate,
      (SELECT count(*)::int FROM offerte_autisti WHERE id=$4 AND stato='accettata') AS offerte_accettate`,
      [ride.id,ids,created.attivazioneId,created.offertaId]);
    assert(counts.corse===1 && counts.prenotazioni===ids.length && counts.pagamenti===ids.length &&
      counts.convertite===ids.length && counts.confermate===1 && counts.offerte_accettate===1,
      'conversione incompleta: '+JSON.stringify(counts));
    observed={corsaId:ride.id,attivazioneId:created.attivazioneId,offertaId:created.offertaId,
      richieste:ids,missioni:2,peak:created.peak,margineEuro:created.margineEuro,walletChecks,counts};
    console.log('C7_ACCEPTANCE_IN_TRANSACTION_PASS',JSON.stringify(observed));
  }});
  assert(observed,'nessun ciclo idoneo per le fixture autorizzate: '+JSON.stringify(result));
  assert(result.persistita===false,'il servizio ha persistito inaspettatamente');
  const {rows:[residue]}=await pool.query(`SELECT
    (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$1) AS attivazioni,
    (SELECT count(*)::int FROM offerte_autisti WHERE id=$2) AS offerte,
    (SELECT count(*)::int FROM corse WHERE id=$3) AS corse,
    (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$3) AS prenotazioni,
    (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$3) AS pagamenti,
    (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($4::int[]) AND stato='convertita' AND corsa_id=$3) AS convertite`,
    [observed.attivazioneId,observed.offertaId,observed.corsaId,observed.richieste]);
  assert(Object.values(residue).every(x=>x===0),'RESIDUI POST ROLLBACK: '+JSON.stringify(residue));
  console.log('C7_ROLLBACK_VERIFICATO_PASS',JSON.stringify({observed,residue}));
} catch(error) {
  console.error('C7_FAIL:',error.stack||error.message);
  process.exitCode=1;
} finally { await pool.end(); }
