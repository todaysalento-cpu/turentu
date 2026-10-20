// TURENTU P0-C6 — test preflight PIXEL multimissione con ROLLBACK
// Eseguire ESCLUSIVAMENTE su database di COLLAUDO.
// Windows CMD: set TURENTU_TEST_DB=1 && node tests\test_pixel_popbus_persistenza_rollback.mjs
// Questo test scrive temporaneamente in transazione; trigger/servizi esterni NON sono annullabili da ROLLBACK.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';
import { verificaAccettazionePixelMulti } from '../services/popbus/v2/popbus-pixel-multi-acceptance-preflight.js';

if (process.env.TURENTU_TEST_DB !== '1') {
  console.error('BLOCCATO: impostare TURENTU_TEST_DB=1 solo su DB di collaudo.');
  process.exitCode = 2;
} else {
  const client = await pool.connect();
  let tx = false;
  try {
    await client.query('BEGIN'); tx = true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    const { rows: pairs } = await client.query(`
      SELECT o.id AS opportunita_id, d.id AS direttrice_id,
             d.engine_id, d.versione, d.nodi,
             array_agg(DISTINCT pr.richiesta_id ORDER BY pr.richiesta_id) AS richieste
      FROM public.pixel_opportunita o
      JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
      JOIN public.pixel_opportunita_richieste pr ON pr.opportunita_id=o.id
      WHERE o.stato='candidata' AND d.stato='attiva'
        AND cardinality(d.nodi)>=2
      GROUP BY o.id,d.id,d.engine_id,d.versione,d.nodi
      ORDER BY o.id
      LIMIT 100
    `);
    let selected = null;
    for (let i=0; i<pairs.length && !selected; i++) {
      for (let j=i+1; j<pairs.length; j++) {
        const a=pairs[i],b=pairs[j];
        const ar=Number(a.richieste[0]),br=Number(b.richieste[0]);
        if (ar!==br && a.nodi.every(n=>Number.isSafeInteger(Number(n))) && b.nodi.every(n=>Number.isSafeInteger(Number(n))) && a.nodi.length < 60 && b.nodi.length < 60) {
          selected=[{...a,requestId:ar},{...b,requestId:br}]; break;
        }
      }
    }
    if (!selected) {
      console.log('SKIP: servono 2 opportunita PIXEL candidate con richieste distinte e nodi validi.');
    } else {
      const {rows: vehicles}=await client.query(`
        SELECT v.id AS veicolo_id,v.driver_id AS autista_id
        FROM public.veicolo v JOIN public.utente u ON u.id=v.driver_id
        ORDER BY v.id LIMIT 1
      `);
      if (!vehicles.length) {
        console.log('SKIP: nessun veicolo/titolare disponibile per il test.');
      } else {
        const vehicle=vehicles[0];
        const start=Date.now()+7*24*60*60*1000;
        const missions=selected.map((p,i)=>{
          const nodes=p.nodi.map(Number);
          const departure=new Date(start+i*60*60*1000);
          const arrival=new Date(departure.getTime()+(nodes.length-1)*60*1000);
          return {
            nodes, departure, arrival,
            legs:Array.from({length:nodes.length-1},()=>({metres:1000,seconds:60,polyline:'??'})),
            requests:[{id:p.requestId,start:0,end:nodes.length-1}],
            pixelOpportunitaId:Number(p.opportunita_id),
            pixelDirettriceId:Number(p.direttrice_id),
            pixelVersione:Number(p.versione),
            corridoioPixelId:p.engine_id
          };
        });
        // Crea il piano globale concatenando le missioni con una tratta sintetica di trasferimento.
        // La tratta e' solo una fixture di persistenza, NON un itinerario operativo.
        const nodes=[...missions[0].nodes];
        const legs=[...missions[0].legs];
        const metas=[{ordine:1,startIndex:0,endIndex:missions[0].nodes.length-1}];
        const globalRequests=[{id:missions[0].requests[0].id,start:0,end:missions[0].nodes.length-1}];
        legs.push({metres:1000,seconds:60,polyline:'??'});
        const base=nodes.length;
        nodes.push(...missions[1].nodes);
        legs.push(...missions[1].legs);
        metas.push({ordine:2,startIndex:base,endIndex:nodes.length-1});
        globalRequests.push({id:missions[1].requests[0].id,start:base,end:nodes.length-1});
        assert.equal(legs.length,nodes.length-1);
        const pianoGlobale={nodes,legs,missioni:metas,evaluation:{requests:globalRequests}};
        const {rows:activations}=await client.query(`
          INSERT INTO public.popbus_attivazioni
            (direttrice_id,veicolo_id,autista_id,stato,partenza,arrivo,
             costo,ricavo,tariffa,piano,expires_at,pixel_opportunita_id)
          VALUES (NULL,$1,$2,'in_attesa_autista',$3,$4,0,0,0,$5::jsonb,$6,NULL)
          RETURNING id
        `,[vehicle.veicolo_id,vehicle.autista_id,missions[0].departure,
          missions[1].arrival,JSON.stringify({test:'P0-C5',...pianoGlobale}),
          new Date(start+24*60*60*1000)]);
        const aid=activations[0].id;
        const ids=await registraMissioniAttivazione(client,{attivazioneId:aid,missioni:missions,pianoGlobale});
        assert.equal(ids.length,2);
        const {rows:local}=await client.query(`
          SELECT m.ordine,m.pixel_opportunita_id,m.corridoio_pixel_id,
                 r.richiesta_id,r.indice_salita,r.indice_discesa
          FROM public.popbus_attivazione_missioni m
          JOIN public.popbus_missione_richieste r ON r.missione_id=m.id
          WHERE m.attivazione_id=$1 ORDER BY m.ordine
        `,[aid]);
        const {rows:global}=await client.query(`
          SELECT richiesta_id,indice_salita,indice_discesa
          FROM public.popbus_attivazione_richieste
          WHERE attivazione_id=$1 ORDER BY richiesta_id
        `,[aid]);
        assert.equal(local.length,2);assert.equal(global.length,2);
        for(let i=0;i<2;i++){
          assert.equal(Number(local[i].pixel_opportunita_id),missions[i].pixelOpportunitaId);
          assert.equal(String(local[i].corridoio_pixel_id),missions[i].corridoioPixelId);
          assert.equal(Number(local[i].indice_salita),0);
          assert.equal(Number(local[i].indice_discesa),missions[i].nodes.length-1);
        }
        for(const expected of globalRequests){
          const got=global.find(r=>Number(r.richiesta_id)===expected.id);
          assert.ok(got);assert.equal(Number(got.indice_salita),expected.start);
          assert.equal(Number(got.indice_discesa),expected.end);
        }
        console.log('PASS: 2 missioni PIXEL persistite nella stessa attivazione (transazione non confermata).');
        console.log('PASS: riferimenti opportunita PIXEL e indici locali/globali coerenti.');
        const attivazione={id:aid,direttrice_id:null,pixel_opportunita_id:null};
        const valid=await verificaAccettazionePixelMulti(client,attivazione,pianoGlobale);
        assert.equal(valid.missioni,2);
        assert.equal(valid.opportunita,2);
        assert.equal(valid.richieste,2);
        console.log('PASS P0-C6: due opportunita PIXEL validate con attivazione principale priva di opportunita_id.');

        // Ogni mutazione e' transazionale, seguita da ROLLBACK TO SAVEPOINT.
        // Non si invoca acceptance.js: niente Stripe, socket o creazione corse.
        async function casoNegativo(label, sql, params, pattern) {
          await client.query('SAVEPOINT p0c6_case');
          try {
            const changed=await client.query(sql,params);
            assert.ok(changed.rowCount>0,`${label}: nessuna riga modificata`);
            await assert.rejects(
              verificaAccettazionePixelMulti(client,attivazione,pianoGlobale),
              pattern,
              `${label}: il preflight non ha rifiutato l'anomalia`
            );
            console.log(`PASS P0-C6: ${label} rifiutato.`);
          } finally {
            await client.query('ROLLBACK TO SAVEPOINT p0c6_case');
            await client.query('RELEASE SAVEPOINT p0c6_case');
          }
          const restored=await verificaAccettazionePixelMulti(client,attivazione,pianoGlobale);
          assert.equal(restored.opportunita,2,`${label}: fixture non ripristinata`);
        }
        await casoNegativo('seconda opportunita annullata',
          `UPDATE public.pixel_opportunita SET stato='superata' WHERE id=$1`,
          [missions[1].pixelOpportunitaId],/PIXEL_MULTI_ACCEPTANCE:.*non attiva/);
        await casoNegativo('versione seconda direttrice modificata',
          `UPDATE public.pixel_direttrici SET versione=versione+1 WHERE id=$1`,
          [missions[1].pixelDirettriceId],/PIXEL_MULTI_ACCEPTANCE:.*versione PIXEL/);
        await casoNegativo('associazione seconda richiesta rimossa',
          `DELETE FROM public.pixel_opportunita_richieste WHERE opportunita_id=$1 AND richiesta_id=$2`,
          [missions[1].pixelOpportunitaId,missions[1].requests[0].id],
          /PIXEL_MULTI_ACCEPTANCE:.*associazione/);
        console.log('PASS P0-C6: ripristino dopo ogni caso negativo verificato.');
        // Rifiuto di mapping errato: la validazione avviene prima di ogni INSERT aggiuntivo.
        const invalid=structuredClone(pianoGlobale);
        invalid.evaluation.requests[0].start=1;
        await assert.rejects(
          registraMissioniAttivazione(client,{attivazioneId:aid,missioni:missions,pianoGlobale:invalid}),
          /mapping globale discordante|Indici globali non validi/
        );
        console.log('PASS: mapping globale alterato rifiutato.');
      }
    }
  } catch(e) {
    console.error('FAIL:',e.stack||e);
    process.exitCode=1;
  } finally {
    if(tx){
      try{await client.query('ROLLBACK');console.log('ROLLBACK eseguito.');}
      catch(e){console.error('ROLLBACK FALLITO:',e.message);process.exitCode=1;}
    }
    client.release();
    await pool.end();
  }
}
