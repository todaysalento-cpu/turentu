// Turentu — acceptance E2E PIXEL-first: wallet simulato IN MEMORIA, DB ROLLBACK.
// Eseguire solo con POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY e POPBUS_PIXEL_FIRST=0
// NON certifica pagamenti reali, fattibilita' economica, multi-missione o COMMIT.
import { pool } from '../db/db.js';
import { leggiFormazioniPixelWorker } from '../services/popbus/v2/pixel-worker-formation-source.js';
import { persistiCandidatoPixelInTransazione } from '../services/popbus/v2/pixel-first-transaction-STAGING.js';
import { verificaAccettazionePixel } from '../services/popbus/v2/popbus-pixel-acceptance-preflight.js';
import { accettaAttivazione } from '../services/popbus/v2/acceptance.js';

const assert = (v, m) => { if (!v) throw new Error('PIXEL_FIRST_STAGING_TEST: ' + m); };
assert(process.env.POPBUS_PIXEL_TX_STAGING === 'ROLLBACK_ONLY', 'impostare POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY');
assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve rimanere disabilitato');
let client, begun = false, activationId = null, offerId = null, rideId = null;
let passed = false;
let originalIdentity = null, testedRequestIds = null;
try {
  client = await pool.connect();
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  assert(db === 'corse_db', `DB inatteso: ${db}`);
  await client.query('BEGIN'); begun = true;
  await client.query("SET LOCAL statement_timeout = '90s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const formations = await leggiFormazioniPixelWorker({client,limit:500,maxFormazioniPerSeed:80});
  assert(formations.length > 0, 'nessuna formazione PIXEL disponibile');
  const vehicleRows = (await client.query(`
    SELECT id, driver_id, posti_totali
    FROM public.veicolo WHERE id = 361 AND driver_id IS NOT NULL LIMIT 1
  `)).rows;
  assert(vehicleRows.length === 1, 'veicolo fixture 361 non disponibile');
  const vehicle = vehicleRows[0];
  const options = formations.filter(f =>
    f.evaluation?.requests?.length &&
    f.evaluation?.arrival > f.evaluation?.departure &&
    f.evaluation?.departure > Date.now() + 20 * 60000 &&
    Number(f.evaluation?.peak) <= Number(vehicle.posti_totali));
  assert(options.length, 'nessuna formazione futura con capienza idonea; non forzare dati');
  // Scegli una formazione con richieste appartenenti a clienti reali.
  // Non alterare mai cliente_id; richieste senza cliente non sono utilizzabili.
  let f = null;
  for (const option of options) {
    const ids = option.richiestaIds.map(Number);
    if (!ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0)) continue;
    const {rows} = await client.query(`
      SELECT r.id, r.cliente_id, r.stato, r.corsa_id, u.id AS cliente_valido
      FROM public.richieste_pop_bus r
      LEFT JOIN public.utente u ON u.id=r.cliente_id AND u.tipo='cliente'
      WHERE r.id=ANY($1::bigint[])
    `,[ids]);
    if (rows.length===ids.length && rows.every(r =>
      r.cliente_id != null && r.cliente_valido != null &&
      r.stato==='in_attesa' && r.corsa_id==null)) {
      f = option;
      break;
    }
  }
  assert(f, 'nessuna formazione PIXEL con clienti validi e richieste in attesa');
  const nodeRows = (await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali WHERE id = ANY($1::bigint[]) AND attivo=TRUE
  `,[f.plan.nodes])).rows;
  assert(nodeRows.length === f.plan.nodes.length, 'nodi territoriali mancanti');
  const nodeMap = new Map(nodeRows.map(n=>[Number(n.id),n]));
  const coordinates = f.plan.nodes.map(id => {
    const n=nodeMap.get(Number(id));
    assert(n, `nodo ${id} assente`);
    return {id:Number(id),nome_nodo:n.nome,lat:Number(n.lat),lon:Number(n.lon)};
  });
  const departure = Number(f.evaluation.departure);
  const arrival = Number(f.evaluation.arrival);
  const requestRows = (await client.query('SELECT id,prezzo FROM richieste_pop_bus WHERE id=ANY($1::bigint[])',[f.richiestaIds])).rows;
  assert(requestRows.length === f.richiestaIds.length, 'richieste non reperibili');
  const revenue = requestRows.reduce((s,r)=>s+Number(r.prezzo),0);
  assert(Number.isFinite(revenue) && revenue>=0, 'prezzi richieste invalidi');
  // ATTENZIONE: costo/economia qui sono esclusivamente valori sintetici di TEST.
  // Non dimostrano economicita', non sono destinati a COMMIT o produzione.
  const candidate = {
    ...f, vehicle: {...vehicle, euro_km: Number(vehicle.euro_km ?? 0)},
    approach:{metres:0},returnTrip:{metres:0},
    busyStart:new Date(departure-10*60000).toISOString(),
    busyEnd:new Date(arrival+10*60000).toISOString(),
    evaluation:{...f.evaluation,revenue},
    economia:{economicamenteAttivabile:true}, cost:0
  };
  // Fixture E2E: preservare sempre il cliente effettivo di ciascuna richiesta.
  // Integrare soltanto gli UUID assenti, esclusivamente in questa transazione.
  const idsToPrepare = [...f.richiestaIds].map(Number).sort((a,b)=>a-b);
  const prepared = (await client.query(`
    SELECT id, cliente_id, request_id, payment_intent_id, stato, corsa_id
    FROM public.richieste_pop_bus
    WHERE id=ANY($1::bigint[])
    ORDER BY id FOR UPDATE
  `,[idsToPrepare])).rows;
  assert(prepared.length===idsToPrepare.length,'fixture: richieste non disponibili');
  originalIdentity = prepared.map(r=>({
    id:Number(r.id), cliente_id:r.cliente_id, request_id:r.request_id,
    payment_intent_id:r.payment_intent_id, stato:r.stato, corsa_id:r.corsa_id
  }));
  testedRequestIds = idsToPrepare;
  for (const r of prepared) {
    assert(r.stato==='in_attesa' && r.corsa_id==null,
      `fixture: richiesta ${r.id} non in attesa`);
    assert(Number.isSafeInteger(Number(r.cliente_id)) && Number(r.cliente_id)>0,
      `fixture: richiesta ${r.id} senza cliente valido`);
    const syntheticUuid = `00000000-0000-4000-8000-${Number(r.id).toString(16).padStart(12,'0')}`;
    await client.query(`
      UPDATE public.richieste_pop_bus
      SET request_id=COALESCE(request_id,$2::uuid)
      WHERE id=$1
    `,[r.id,syntheticUuid]);
  }
  const fixtureAfter=(await client.query(`
    SELECT id,cliente_id,request_id FROM public.richieste_pop_bus
    WHERE id=ANY($1::bigint[])
  `,[idsToPrepare])).rows;
  const originalOwners=new Map(originalIdentity.map(r=>[r.id,String(r.cliente_id)]));
  const requestUuids=fixtureAfter.map(r=>String(r.request_id));
  assert(fixtureAfter.length===idsToPrepare.length &&
    fixtureAfter.every(r=>r.request_id &&
      String(r.cliente_id)===originalOwners.get(Number(r.id))) &&
    new Set(requestUuids).size===requestUuids.length,
    'fixture: identita cliente/richiesta incompleta o UUID duplicati');
  console.log('PIXEL_FIRST_E2E_FIXTURE_JSON:'+JSON.stringify({
    passed:true,richieste:fixtureAfter.length,
    clientiDistinti:new Set(fixtureAfter.map(r=>String(r.cliente_id))).size,
    scope:'BEGIN/ROLLBACK; nessuna modifica permanente'}));
  // Soltanto nella transazione: ref wallet fittizi; niente Stripe e nessun addebito wallet.
  // La query di verifica saldo viene intercettata in memoria (vedi proxy sotto).
 const { rowCount: refsUpdated } = await client.query(
  `UPDATE richieste_pop_bus
   SET payment_intent_id = 'wallet_pixel_e2e_test_' || id::text
   WHERE id = ANY($1::int[])
     AND stato = 'in_attesa'`,
  [f.richiestaIds]
);

assert(
  refsUpdated === f.richiestaIds.length,
  'non tutte le richieste possono essere isolate per test wallet'
);
  const result = await persistiCandidatoPixelInTransazione(client,candidate,{coordinates});
  activationId = result.attivazioneId; offerId = result.offertaId;
  const rows = (await client.query(`
    SELECT a.id,a.direttrice_id,a.pixel_opportunita_id,a.stato,
      (SELECT count(*)::int FROM popbus_attivazione_missioni m WHERE m.attivazione_id=a.id) AS missioni,
      (SELECT count(*)::int FROM popbus_attivazione_richieste r WHERE r.attivazione_id=a.id AND r.attiva) AS richieste,
      (SELECT count(*)::int FROM offerte_autisti o WHERE o.attivazione_id=a.id AND o.direttrice_id IS NULL AND o.stato='inviata') AS offerte
    FROM popbus_attivazioni a WHERE a.id=$1
  `,[activationId])).rows;
  const a=rows[0];
  assert(a && a.direttrice_id===null && Number(a.pixel_opportunita_id)===Number(f.pixelOpportunitaId),'attivazione PIXEL non valida');
  assert(a.missioni===1 && a.richieste===f.richiestaIds.length && a.offerte===1,'associazioni non valide');
  const activation = (await client.query('SELECT * FROM popbus_attivazioni WHERE id=$1',[activationId])).rows[0];
  const preflight = await verificaAccettazionePixel(client,activation,activation.piano);
  assert(preflight.richieste===f.richiestaIds.length,'preflight acceptance non coerente');
  console.log('PIXEL_FIRST_ACCEPTANCE_PREFLIGHT_JSON:'+JSON.stringify({passed:true,attivazioneId:activationId,offertaId:offerId,richieste:preflight.richieste,direttriceLegacy:activation.direttrice_id}));
  // Il client proxy intercetta SOLO la lettura di saldo wallet di verificaPagamento.
  // Tutte le altre query usano il vero client nella stessa transazione.
  // Se cambia la query di verifica, il test fallisce chiuso (nessun wallet reale).
  let walletChecks=0;
  const walletCheckedIds=new Set();
  const requestPrices=new Map(requestRows.map(r=>[Number(r.id),Number(r.prezzo)]));
  const requestOwners=new Map((await client.query(
    'SELECT id,request_id,cliente_id,prezzo FROM richieste_pop_bus WHERE id=ANY($1::int[])',
    [f.richiestaIds])).rows.map(r=>[String(r.request_id),r]));
  assert(requestOwners.size===f.richiestaIds.length, 'wallet test: request_id duplicati');
  const acceptanceClient={
    query: async (sql,params=[]) => {
      const q=String(sql).replace(/\s+/g,' ').trim();
      if (/^SELECT COALESCE\(SUM\(importo\), 0\) AS totale FROM transazioni_wallet WHERE utente_id = \$1 AND riferimento_id::text = \$2$/i.test(q)) {
        const row=requestOwners.get(String(params[1]));
        assert(row && Number(row.cliente_id)===Number(params[0]),'wallet test: identita cliente/richiesta non coerente');
        const prezzo=requestPrices.get(Number(row.id));
        assert(Number.isFinite(prezzo) && prezzo>=0,'wallet test: prezzo non valido');
        assert(!walletCheckedIds.has(Number(row.id)), 'wallet test: richiesta verificata due volte');
        walletCheckedIds.add(Number(row.id));
        walletChecks++;
        return {rows:[{totale:String(-prezzo)}],rowCount:1};
      }
      if (/transazioni_wallet/i.test(q)) throw new Error('PIXEL_E2E_WALLET_QUERY_NON_INTERCETTATA');
      return client.query(sql,params);
    }
  };
  // accettaAttivazione usa la vera logica, incluso INSERT corsa/prenotazioni/pagamenti.
  // Il pagamento e' l'unica dipendenza simulata, e non viene chiamato Stripe.
const ride = await accettaAttivazione(
  acceptanceClient,
  offerId,
  Number(vehicle.driver_id),
  {
    modalita: 'manuale',
    conducenteId: 9
  }
);
  assert(ride?.id,'acceptance non ha restituito una corsa');
  rideId=ride.id;
  assert(walletChecks===f.richiestaIds.length && walletCheckedIds.size===f.richiestaIds.length,
    'numero verifiche wallet simulate non coerente');
  const {rows: e2eRows}=await client.query(`
    SELECT
      (SELECT count(*)::int FROM corse WHERE id=$1) AS corse,
      (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$1) AS prenotazioni,
      (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$1) AS pagamenti,
      (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($2::int[]) AND stato='convertita' AND corsa_id=$1) AS convertite,
      (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$3 AND stato='confermata' AND corsa_id=$1 AND direttrice_id IS NULL) AS attivazioni_confermate,
      (SELECT count(*)::int FROM offerte_autisti
 WHERE id=$4 AND stato='accettata') AS offerte_accettate,
(SELECT count(*)::int FROM assegnazioni_conducenti
 WHERE attivazione_id=$3
   AND conducente_id=9
   AND operatore_id=2
   AND veicolo_id=361
   AND stato='assegnata') AS assegnazioni
  `,[ride.id,f.richiestaIds,activationId,offerId]);
  const v=e2eRows[0];
  assert(v.corse===1 && v.prenotazioni===f.richiestaIds.length &&
    v.pagamenti===f.richiestaIds.length && v.convertite===f.richiestaIds.length &&
    v.attivazioni_confermate===1 && v.offerte_accettate===1 && v.assegnazioni===1,
    'conversione DB incompleta: '+JSON.stringify(v));
  console.log('PIXEL_FIRST_ACCEPTANCE_E2E_JSON:'+JSON.stringify({passed:true,
    corsaId:ride.id,attivazioneId:activationId,offertaId:offerId,
    walletChecksSimulati:walletChecks,...v,
    limiti:['Wallet simulato soltanto in memoria: nessun pagamento reale verificato',
      'Economia e ritorno sintetici: non certifica fattibilita operativa',
      'Solo una missione; non prova multi-missione o concorrenza','ROLLBACK obbligatorio']}));
  console.log('PIXEL_FIRST_STAGING_JSON:'+JSON.stringify({passed:true,db,attivazioneId:activationId,offertaId:offerId,opportunitaId:f.pixelOpportunitaId,richieste:a.richieste,missioni:a.missioni,offerte:a.offerte,direttriceLegacy:a.direttrice_id,limiti:['Economia e avvicinamento/ritorno sintetici: NON fattibilita operativa','Non prova accettazione o concorrenza','Non eseguire COMMIT']}));
  passed=true;
} catch(e) {
  console.error('PIXEL_FIRST_ACCEPTANCE_TEST_ERROR:',e.stack||e.message);
  process.exitCode=1;
} finally {
  if(begun) {
    try {await client.query('ROLLBACK');console.log('PIXEL_FIRST_ACCEPTANCE_E2E_ROLLBACK_OK');}
    catch(e){console.error('PIXEL_FIRST_STAGING_ROLLBACK_ERROR:',e.message);process.exitCode=1;}
  }
  client?.release();
  if(activationId!=null) {
    const verify=await pool.connect();
    try {
      const {rows}=await verify.query(`SELECT
        (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$1) AS attivazioni,
        (SELECT count(*)::int FROM offerte_autisti WHERE id=$2) AS offerte,
        (SELECT count(*)::int FROM corse WHERE id=$3) AS corse,
        (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$3) AS prenotazioni,
        (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$3) AS pagamenti,
        (SELECT count(*)::int FROM assegnazioni_conducenti WHERE corsa_id=$3) AS assegnazioni`,[activationId,offerId,rideId]);
      const clean=Object.values(rows[0]).every(n=>n===0);
      console.log('PIXEL_FIRST_ACCEPTANCE_E2E_VERIFY_JSON:'+JSON.stringify({passed:clean,attivazioneAssente:rows[0].attivazioni===0,offertaAssente:rows[0].offerte===0,corsaAssente:rows[0].corse===0,prenotazioniAssenti:rows[0].prenotazioni===0,pagamentiAssenti:rows[0].pagamenti===0,assegnazioniAssenti:rows[0].assegnazioni===0}));
      if(testedRequestIds) {
        const restored=(await verify.query(`
          SELECT id,cliente_id,request_id,payment_intent_id,stato,corsa_id FROM public.richieste_pop_bus
          WHERE id=ANY($1::bigint[])
        `,[testedRequestIds])).rows;
        const original=new Map(originalIdentity.map(r=>[r.id,r]));
        const identitiesRestored=restored.length===original.size && restored.every(r=>{
          const o=original.get(Number(r.id));
          return o && String(r.cliente_id??'')===String(o.cliente_id??'') &&
            String(r.request_id??'')===String(o.request_id??'') &&
            String(r.payment_intent_id??'')===String(o.payment_intent_id??'') &&
            String(r.stato??'')===String(o.stato??'') &&
            String(r.corsa_id??'')===String(o.corsa_id??'');
        });
        console.log('PIXEL_FIRST_E2E_FIXTURE_ROLLBACK_JSON:'+JSON.stringify({
          passed:identitiesRestored,richieste:restored.length,
          identitaOriginaliRipristinate:identitiesRestored
        }));
        if(!identitiesRestored)process.exitCode=1;
      }
      if(!clean)process.exitCode=1;
    }catch(e){console.error('PIXEL_FIRST_STAGING_VERIFY_ERROR:',e.message);process.exitCode=1;}
    finally{verify.release();}
  }
  if(!passed && process.exitCode==null)process.exitCode=1;
  await pool.end();
}
