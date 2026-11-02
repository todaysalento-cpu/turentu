'use strict';
// Fase 5P: inventario FAIL-CLOSED delle fixture A/R. SOLO LETTURA.
// Nessuna chiamata a acceptance.js, nessun INSERT/UPDATE/DELETE, nessun Stripe.
const path = require('node:path');

async function main() {
  const id = Number(process.env.TURENTU_TEST_AR_ACTIVATION_ID);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Impostare TURENTU_TEST_AR_ACTIVATION_ID con ID fixture dedicata');
  if (process.env.TURENTU_TEST_AR_CONFIRM !== 'ROLLBACK_ONLY') throw new Error('Impostare TURENTU_TEST_AR_CONFIRM=ROLLBACK_ONLY');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL mancante');
  const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));
  const client = new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});
  let transaction = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '8000ms'");
    const q = await client.query(`
      SELECT g.id::text AS group_id, g.stato AS group_state, g.expires_at AS group_expires,
             r.id AS request_id, r.cliente_id, r.ar_tratta, r.ar_vincolata,
             r.stato AS request_state, r.corsa_id AS request_ride,
             r.payment_intent_id, r.request_id AS wallet_reference,
             ar.attivazione_id AS activation_id, ar.attiva AS link_active,
             a.veicolo_id, a.autista_id, a.stato AS activation_state,
             a.corsa_id AS activation_ride, a.expires_at AS activation_expires,
             o.id AS offer_id, o.stato AS offer_state, o.expires_at AS offer_expires,
             aa.id AS acceptance_id, aa.stato AS acceptance_state, aa.expires_at AS acceptance_expires
      FROM public.popbus_attivazione_richieste ar0
      JOIN public.richieste_pop_bus r0 ON r0.id=ar0.richiesta_id
      JOIN public.ar_gruppi g ON g.id=r0.ar_group_id
      JOIN public.richieste_pop_bus r ON r.ar_group_id=g.id
      LEFT JOIN public.popbus_attivazione_richieste ar ON ar.richiesta_id=r.id AND ar.attiva IS TRUE
      LEFT JOIN public.popbus_attivazioni a ON a.id=ar.attivazione_id
      LEFT JOIN public.offerte_autisti o ON o.attivazione_id=a.id AND o.stato='accettata'
      LEFT JOIN public.popbus_ar_accettazioni aa ON aa.attivazione_id=a.id
      WHERE ar0.attivazione_id=$1 AND ar0.attiva IS TRUE
      ORDER BY g.id,r.ar_tratta,r.id,ar.attivazione_id,o.id,aa.id`,[id]);
    const rows=q.rows;
    if (!rows.length) throw new Error('NESSUNA FIXTURE: attivazione senza richieste A/R collegate');
    const errors=[];
    const unique=(values)=>[...new Set(values)];
    const groups=unique(rows.map(r=>r.group_id));
    const requestIds=unique(rows.map(r=>String(r.request_id)));
    const activationIds=unique(rows.map(r=>r.activation_id==null?'':String(r.activation_id)));
    const offers=unique(rows.map(r=>r.offer_id==null?'':String(r.offer_id)));
    const acceptances=unique(rows.map(r=>r.acceptance_id==null?'':String(r.acceptance_id)));
    if(groups.length!==1) errors.push(`attesi 1 gruppo, trovati ${groups.length}`);
    if(requestIds.length!==2) errors.push(`attese 2 richieste, trovate ${requestIds.length}`);
    if(activationIds.length!==2||activationIds.includes('')) errors.push(`attese 2 attivazioni collegate, trovate ${activationIds.join(',')}`);
    if(offers.length!==2||offers.includes('')) errors.push('richieste esattamente 2 offerte accettate');
    if(acceptances.length!==2||acceptances.includes('')) errors.push('richieste esattamente 2 accettazioni A/R');
    const legs=unique(rows.map(r=>r.ar_tratta));
    if(legs.length!==2||!legs.includes('andata')||!legs.includes('ritorno')) errors.push(`tratte non valide: ${legs.join(',')}`);
    const now=Date.now();
    for(const r of rows){
      const prefix=`richiesta ${r.request_id}: `;
      if(r.ar_vincolata!==true) errors.push(prefix+'non vincolata A/R');
      if(r.request_state!=='in_lavorazione'||r.request_ride!=null) errors.push(prefix+'stato/corsa non predisposti');
      if(!String(r.payment_intent_id||'').startsWith('wallet_')) errors.push(prefix+'pagamento non wallet di test');
      if(!r.wallet_reference) errors.push(prefix+'request_id wallet mancante');
      if(![357,358].includes(Number(r.veicolo_id))||Number(r.autista_id)!==2) errors.push(prefix+'veicolo/operatore non dedicati al test');
      if(r.activation_state!=='in_attesa_autista'||r.activation_ride!=null) errors.push(prefix+'attivazione non predisposta');
      if(r.offer_state!=='accettata') errors.push(prefix+'offerta non accettata');
      if(r.acceptance_state!=='provvisoria') errors.push(prefix+'accettazione A/R non provvisoria');
      for(const [field,value] of [['gruppo',r.group_expires],['attivazione',r.activation_expires],['offerta',r.offer_expires],['accettazione',r.acceptance_expires]]) {
        if(!value||new Date(value).getTime()<=now) errors.push(prefix+field+' scaduto');
      }
    }
    const gstate=unique(rows.map(r=>r.group_state));
    if(gstate.length!==1||!['autorizzato','in_attesa','pronto'].includes(gstate[0])) errors.push('stato gruppo non finalizzabile');
    console.log('FASE 5P - INVENTARIO READ ONLY');
    console.log(JSON.stringify({groups,requestIds,activationIds,offers,acceptances,legs,groupStates:gstate,rows:rows.map(r=>({request:r.request_id,leg:r.ar_tratta,activation:r.activation_id,vehicle:r.veicolo_id,operator:r.autista_id,requestState:r.request_state,activationState:r.activation_state,offer:r.offer_id,acceptance:r.acceptance_id}))},null,2));
    if(errors.length) { console.error('NON PRONTO:',errors.join(' | ')); process.exitCode=2; }
    else console.log('PRECHECK STRUTTURALE OK. NON ESEGUIRE ANCORA IL FINALIZZATORE: manca verifica isolamento fixture, piano, PIXEL e pagamento wallet.');
  } finally {
    if(transaction) { try { await client.query('ROLLBACK'); console.log('ROLLBACK READ ONLY OK'); } catch(e){ console.error('ROLLBACK ERROR:',e.message);process.exitCode=3; } }
    await client.end().catch(()=>{});
  }
}
main().catch(e=>{console.error('FASE 5P:',e.message);process.exitCode=1;});
