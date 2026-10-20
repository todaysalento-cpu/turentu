// TURENTU — preflight acceptance PIXEL su PostgreSQL reale, SEMPRE ROLLBACK.
// Salva in tests/test_pixel_acceptance_preflight_postgres_rollback.js
// node --env-file=.env tests\test_pixel_acceptance_preflight_postgres_rollback.js
// Non avvia worker, acceptance, Stripe o socket. Eseguire su DB di collaudo.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';
import { verificaAccettazionePixel } from '../services/popbus/v2/popbus-pixel-acceptance-preflight.js';

let client;
let transactionOpen = false;
let passed = 0;
const pass = name => { passed++; console.log('PASS', name); };
async function negative(name, run, pattern) {
  await assert.rejects(run, pattern);
  pass(name);
}
try {
  client = await pool.connect();
  await client.query('BEGIN'); transactionOpen = true;
  await client.query("SET LOCAL lock_timeout = '3000ms'");
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '60000ms'");

  const { rows: vehicles } = await client.query(
    'SELECT id, driver_id FROM public.veicolo WHERE driver_id IS NOT NULL ORDER BY id LIMIT 1');
  if (!vehicles.length) throw new Error('Nessun veicolo con driver_id per fixture');
  const vehicle = vehicles[0];
  const { rows: requests } = await client.query(`
    INSERT INTO public.richieste_pop_bus
      (cliente_id, origine, destinazione, start_datetime, posti_richiesti,
       stato, classe, origine_address, destinazione_address, prezzo)
    VALUES (NULL,NULL,NULL,now() + interval '2 hours',1,'in_attesa','STANDARD',
            'TEST PIXEL salita','TEST PIXEL discesa',0)
    RETURNING id`);
  const requestId = requests[0].id;
  const nodes = [900000001,900000002];
  const legs = [{ metres:1000, seconds:120, polyline:'', roadCoincident:true }];
  const engineId = `PIXEL_ACCEPTANCE_ROLLBACK_${process.pid}_${Date.now()}`;
  const start = new Date(Date.now()+2*3600000);
  const end = new Date(start.getTime()+20*60000);
  const { rows: corridors } = await client.query(`
    INSERT INTO public.pixel_direttrici(engine_id,versione,nodi,legs,stato)
    VALUES ($1,1,$2::bigint[],$3::jsonb,'attiva') RETURNING id`,
    [engineId,nodes,JSON.stringify(legs)]);
  const corridorId = corridors[0].id;
  const { rows: opportunities } = await client.query(`
    INSERT INTO public.pixel_opportunita
      (direttrice_id,inizio_finestra,fine_finestra,dati_temporali,stato)
    VALUES ($1,$2,$3,$4::jsonb,'candidata') RETURNING id`,
    [corridorId,start,end,JSON.stringify({testOnly:true})]);
  const opportunityId = opportunities[0].id;
  await client.query(`INSERT INTO public.pixel_opportunita_richieste(opportunita_id,richiesta_id)
                      VALUES ($1,$2)`,[opportunityId,requestId]);
  const plan = {nodes,evaluation:{requests:[{id:requestId,start:0,end:1}]}};
  const { rows: activations } = await client.query(`
    INSERT INTO public.popbus_attivazioni
      (veicolo_id,autista_id,direttrice_id,pixel_opportunita_id,piano,
       partenza,arrivo,costo,ricavo,tariffa,expires_at,stato)
    VALUES ($1,$2,NULL,$3,$4::jsonb,$5,$6,0,0,0,$7,'in_attesa_autista')
    RETURNING id`,[vehicle.id,vehicle.driver_id,opportunityId,JSON.stringify(plan),start,end,
                   new Date(start.getTime()+15*60000)]);
  const activationId = activations[0].id;
  const mission = {pixelOpportunitaId:opportunityId,pixelDirettriceId:corridorId,
    pixelVersione:1,corridoioPixelId:engineId,nodes,legs,
    requests:[{id:requestId,start:0,end:1}],departure:start,arrival:end};
  const missionIds = await registraMissioniAttivazione(client,{attivazioneId:activationId,missioni:[mission]});
  assert.equal(missionIds.length,1);
  await client.query(`INSERT INTO public.popbus_attivazione_richieste
    (attivazione_id,richiesta_id,attiva,indice_salita,indice_discesa)
    VALUES ($1,$2,true,0,1)`,[activationId,requestId]);
  const activation = {id:activationId,pixel_opportunita_id:opportunityId,direttrice_id:null};
  const valid = await verificaAccettazionePixel(client,activation,plan);
  assert.equal(Number(valid.opportunitaId),Number(opportunityId));
  assert.equal(valid.richieste,1);
  pass('fixture reale: opportunita, missione e associazioni valide');

  await negative('direttrice legacy vietata',()=>verificaAccettazionePixel(client,
    {...activation,direttrice_id:1},plan),/legacy/i);
  await negative('nodi del piano discordanti',()=>verificaAccettazionePixel(client,activation,
    {...plan,nodes:[nodes[0],900000003]}),/nodi/i);
  await negative('indici del piano discordanti',()=>verificaAccettazionePixel(client,activation,
    {...plan,evaluation:{requests:[{id:requestId,start:1,end:1}]} }),/indici/i);

  async function changed(name, sql, params, pattern) {
    await client.query('SAVEPOINT pixel_test_case');
    try {
      await client.query(sql,params);
      await negative(name,()=>verificaAccettazionePixel(client,activation,plan),pattern);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT pixel_test_case');
      await client.query('RELEASE SAVEPOINT pixel_test_case');
    }
  }
  await changed('opportunita non candidata',
    `UPDATE public.pixel_opportunita SET stato='superata' WHERE id=$1`,[opportunityId],/non attiva/i);
  await changed('direttrice disattivata',
    `UPDATE public.pixel_direttrici SET stato='archiviata' WHERE id=$1`,[corridorId],/non attiva/i);
  await changed('versione PIXEL cambiata',
    `UPDATE public.pixel_direttrici SET versione=versione+1 WHERE id=$1`,[corridorId],/versione/i);
  await changed('associazione PIXEL rimossa',
    `DELETE FROM public.pixel_opportunita_richieste WHERE opportunita_id=$1 AND richiesta_id=$2`,
    [opportunityId,requestId],/associate|incomplete/i);
  await changed('indici persistiti discordanti',
    `UPDATE public.popbus_attivazione_richieste SET indice_salita=1 WHERE attivazione_id=$1`,
    [activationId],/indici/i);
  console.log(`RISULTATO: ${passed}/9 PASS - PostgreSQL reale, fixture transazionale`);
} catch(e) {
  console.error('FAIL:',e.stack || e.message);
  process.exitCode=1;
} finally {
  if (client) {
    if (transactionOpen) {
      try {await client.query('ROLLBACK');console.log('ROLLBACK_OK');}
      catch(e){console.error('ROLLBACK_ERROR:',e.message);process.exitCode=1;}
    }
    client.release();
  }
  await pool.end();
}
