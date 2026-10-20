// Turentu — test reale STAGING PIXEL-first, scritture sempre annullate.
// Eseguire solo con: node --env-file=.env tests/test_pixel_first_staging_rollback.js
// NON certifica fattibilita' economica, turni, routing o acceptance.
import { pool } from '../db/db.js';
import { leggiFormazioniPixelWorker } from '../services/popbus/v2/pixel-worker-formation-source.js';
import { persistiCandidatoPixelInTransazione } from '../services/popbus/v2/pixel-first-transaction-STAGING.js';

const assert = (v, m) => { if (!v) throw new Error('PIXEL_FIRST_STAGING_TEST: ' + m); };
assert(process.env.POPBUS_PIXEL_TX_STAGING === 'ROLLBACK_ONLY', 'impostare POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY');
assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve rimanere disabilitato');
let client, begun = false, activationId = null, offerId = null;
let passed = false;
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
  const f = options[0];
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
  console.log('PIXEL_FIRST_STAGING_JSON:'+JSON.stringify({passed:true,db,attivazioneId:activationId,offertaId:offerId,opportunitaId:f.pixelOpportunitaId,richieste:a.richieste,missioni:a.missioni,offerte:a.offerte,direttriceLegacy:a.direttrice_id,limiti:['Economia e avvicinamento/ritorno sintetici: NON fattibilita operativa','Non prova accettazione o concorrenza','Non eseguire COMMIT']}));
  passed=true;
} catch(e) {
  console.error('PIXEL_FIRST_STAGING_ERROR:',e.stack||e.message);
  process.exitCode=1;
} finally {
  if(begun) {
    try {await client.query('ROLLBACK');console.log('PIXEL_FIRST_STAGING_ROLLBACK_OK');}
    catch(e){console.error('PIXEL_FIRST_STAGING_ROLLBACK_ERROR:',e.message);process.exitCode=1;}
  }
  client?.release();
  if(activationId!=null) {
    const verify=await pool.connect();
    try {
      const {rows}=await verify.query(`SELECT
        (SELECT count(*)::int FROM popbus_attivazioni WHERE id=$1) AS attivazioni,
        (SELECT count(*)::int FROM offerte_autisti WHERE id=$2) AS offerte`,[activationId,offerId]);
      const clean=rows[0].attivazioni===0 && rows[0].offerte===0;
      console.log('PIXEL_FIRST_STAGING_VERIFY_JSON:'+JSON.stringify({passed:clean,attivazioneAssente:rows[0].attivazioni===0,offertaAssente:rows[0].offerte===0}));
      if(!clean)process.exitCode=1;
    }catch(e){console.error('PIXEL_FIRST_STAGING_VERIFY_ERROR:',e.message);process.exitCode=1;}
    finally{verify.release();}
  }
  await pool.end();
}
