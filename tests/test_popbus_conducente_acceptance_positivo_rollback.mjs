// TEST ESCLUSIVAMENTE SU DATABASE ISOLATO. NON PRODUZIONE.
// Turentu - acceptance E2E POSITIVA con titolare: wallet simulato in memoria, DB ROLLBACK.
// Eseguire solo con POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY e POPBUS_PIXEL_FIRST=0
// NON certifica pagamenti reali, fattibilita' economica, multi-missione o COMMIT.
import { pool } from '../db/db.js';
import { leggiFormazioniPixelWorker } from '../services/popbus/v2/pixel-worker-formation-source.js';
import { persistiCandidatoPixelInTransazione } from '../services/popbus/v2/pixel-first-transaction-STAGING.js';
import { verificaAccettazionePixel } from '../services/popbus/v2/popbus-pixel-acceptance-preflight.js';
import { accettaAttivazione } from '../services/popbus/v2/acceptance.js';

const assert = (v, m) => { if (!v) throw new Error('PIXEL_FIRST_STAGING_TEST: ' + m); };
assert(process.env.TURENTU_ISOLATED_TEST_DB === 'YES', 'richiesta conferma esplicita DB di test isolato');
assert(process.env.POPBUS_CONDUCENTI_ENABLED === 'true', 'abilitare conducenti solo nel processo di test');
assert(process.env.POPBUS_PIXEL_TX_STAGING === 'ROLLBACK_ONLY', 'impostare POPBUS_PIXEL_TX_STAGING=ROLLBACK_ONLY');
assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve rimanere disabilitato');
let client, begun = false, activationId = null, offerId = null, rideId = null;
let passed = false;
let inserts = {corse:0, prenotazioni:0, pagamenti:0};
let acceptedSuccessfully = false;
try {
  client = await pool.connect();
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  assert(db === 'corse_db', `DB inatteso: ${db}`);
  console.log('DB TEST (ISOLAMENTO DA VERIFICARE ESTERNAMENTE):', db);
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
  // Soltanto nella transazione: ref wallet fittizi; niente Stripe e nessun addebito wallet.
  // La query di verifica saldo viene intercettata in memoria (vedi proxy sotto).
  const {rowCount: refsUpdated} = await client.query(
    `UPDATE richieste_pop_bus
     SET payment_intent_id='wallet_pixel_e2e_test_' || id::text
     WHERE id=ANY($1::int[]) AND stato='in_attesa'`, [f.richiestaIds]);
  assert(refsUpdated===f.richiestaIds.length,'non tutte le richieste possono essere isolate per test wallet');
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
  const requestPrices=new Map(requestRows.map(r=>[Number(r.id),Number(r.prezzo)]));
  const requestOwners=new Map((await client.query(
    'SELECT id,request_id,cliente_id,prezzo FROM richieste_pop_bus WHERE id=ANY($1::int[])',
    [f.richiestaIds])).rows.map(r=>[String(r.request_id),r]));
  const acceptanceClient={
    query: async (sql,params=[]) => {
      const q=String(sql).replace(/\s+/g,' ').trim();
      if (/^SELECT COALESCE\(SUM\(importo\), 0\) AS totale FROM transazioni_wallet WHERE utente_id = \$1 AND riferimento_id::text = \$2$/i.test(q)) {
        const row=requestOwners.get(String(params[1]));
        assert(row && Number(row.cliente_id)===Number(params[0]),'wallet test: identita cliente/richiesta non coerente');
        const prezzo=requestPrices.get(Number(row.id));
        assert(Number.isFinite(prezzo) && prezzo>=0,'wallet test: prezzo non valido');
        walletChecks++;
        return {rows:[{totale:String(-prezzo)}],rowCount:1};
      }
      if (/transazioni_wallet/i.test(q)) throw new Error('PIXEL_E2E_WALLET_QUERY_NON_INTERCETTATA');
      const result = await client.query(sql,params);
      if (/^INSERT INTO corse\s*\(/i.test(q)) { inserts.corse++; rideId = result.rows?.[0]?.id ?? rideId; }
      if (/^INSERT INTO prenotazioni\s*\(/i.test(q)) inserts.prenotazioni++;
      if (/^INSERT INTO pagamenti\s*\(/i.test(q)) inserts.pagamenti++;
      return result;
    }
  };
  // accettaAttivazione usa la vera logica, incluso INSERT corsa/prenotazioni/pagamenti.
  // Il pagamento e' l'unica dipendenza simulata, e non viene chiamato Stripe.
  // TEST POSITIVO: il titolare viene assegnato esplicitamente.
  // Tutte le modifiche restano nella stessa transazione, poi ROLLBACK.
  const corsa = await accettaAttivazione(acceptanceClient, offerId, Number(vehicle.driver_id), {
    modalita: 'titolare', conducenteId: Number(vehicle.driver_id)
  });
  assert(corsa?.id != null, 'accettazione non completata');
  assert(Number(corsa.id) === Number(rideId), 'ID corsa restituito incoerente');
  assert(inserts.corse === 1, 'numero INSERT corse errato');
  assert(inserts.prenotazioni === f.richiestaIds.length, 'INSERT prenotazioni incompleti');
  assert(inserts.pagamenti === f.richiestaIds.length, 'INSERT pagamenti incompleti');
  assert(walletChecks === f.richiestaIds.length, 'verifiche wallet incomplete');

  const {rows: assegnazioni} = await client.query(`
    SELECT conducente_id, veicolo_id, operatore_id, modalita, stato,
           lower(intervallo_operativo) AS inizio,
           upper(intervallo_operativo) AS fine
    FROM assegnazioni_conducenti
    WHERE attivazione_id=$1`, [activationId]);
  assert(assegnazioni.length === 1, 'assegnazione conducente non creata o duplicata');
  const assegnazione = assegnazioni[0];
  assert(Number(assegnazione.conducente_id) === Number(vehicle.driver_id), 'conducente errato');
  assert(Number(assegnazione.operatore_id) === Number(vehicle.driver_id), 'operatore errato');
  assert(Number(assegnazione.veicolo_id) === Number(vehicle.id), 'veicolo errato');
  assert(assegnazione.modalita === 'titolare', 'modalita assegnazione errata');
  assert(assegnazione.stato === 'assegnata', 'assegnazione non attiva');
  assert(new Date(assegnazione.inizio).getTime() === new Date(candidate.busyStart).getTime(),
    'inizio intervallo operativo errato');
  assert(new Date(assegnazione.fine).getTime() === new Date(candidate.busyEnd).getTime(),
    'fine intervallo operativo errata');

  const {rows: conferma} = await client.query(`
    SELECT a.stato AS stato_attivazione, a.corsa_id,
           o.stato AS stato_offerta
    FROM popbus_attivazioni a
    JOIN offerte_autisti o ON o.attivazione_id=a.id
    WHERE a.id=$1 AND o.id=$2`, [activationId, offerId]);
  assert(conferma.length === 1, 'conferma attivazione/offerta non trovata');
  assert(conferma[0].stato_attivazione === 'confermata', 'attivazione non confermata');
  assert(conferma[0].stato_offerta === 'accettata', 'offerta non accettata');
  assert(Number(conferma[0].corsa_id) === Number(corsa.id), 'corsa non collegata alla attivazione');

  acceptedSuccessfully = true;
  passed = true;
  console.log('POPBUS_CONDUCENTE_POSITIVO_OK:'+JSON.stringify({
    passed:true, corsaId:corsa.id, attivazioneId:activationId, offertaId:offerId,
    conducenteId:Number(assegnazione.conducente_id), veicoloId:Number(assegnazione.veicolo_id),
    prenotazioni:inserts.prenotazioni, pagamenti:inserts.pagamenti
  }));
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
        (SELECT count(*)::int FROM assegnazioni_conducenti WHERE attivazione_id=$1) AS assegnazioni`,[activationId,offerId,rideId]);
      const clean=Object.values(rows[0]).every(n=>n===0);
      console.log('PIXEL_FIRST_ACCEPTANCE_E2E_VERIFY_JSON:'+JSON.stringify({passed:clean,attivazioneAssente:rows[0].attivazioni===0,offertaAssente:rows[0].offerte===0,corsaAssente:rows[0].corse===0,prenotazioniAssenti:rows[0].prenotazioni===0,pagamentiAssenti:rows[0].pagamenti===0,assegnazioniAssenti:rows[0].assegnazioni===0}));
      if(!clean)process.exitCode=1;
    }catch(e){console.error('PIXEL_FIRST_STAGING_VERIFY_ERROR:',e.message);process.exitCode=1;}
    finally{verify.release();}
  }
  if (!acceptedSuccessfully || !passed) process.exitCode=1;
  await pool.end();
}
