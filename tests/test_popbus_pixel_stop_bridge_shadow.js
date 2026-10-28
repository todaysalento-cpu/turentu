// Test contrattuale SHADOW: dipendenze mock, nessuna query DB/routing reale.
import assert from 'node:assert/strict';
import { generaAlternativeFisichePixelShadow as bridge } from '../services/popbus/v2/popbus-pixel-stop-bridge.service.js';
import { generaAssegnazioniFermate } from '../services/popbus/v2/popbus-stop-assignment.service.js';

const t = Date.parse('2026-11-01T10:00:00+01:00');
const richiesta = {id:900001,posti_richiesti:2,prezzo:11};
const formazione = {pixelOpportunitaId:301,pixelDirettriceId:202,pixelVersione:3,
  nodiTerritoriali:[5,6],departure:t,evaluation:{requests:[{id:900001,start:0,end:1}]}};
const stop = (fermata_id, distanza_metri) => ({fermata_id,lat:40.12+fermata_id/10000,
  lon:18.3,distanza_metri,tipi_veicolo_ammessi:['autobus']});
const candidati = [{richiesta_id:900001,salita:[stop(14,50)],discesa:[stop(15,80)]}];
const client = {query:()=>{throw Error('QUERY DB NON CONSENTITA NEL TEST');}};
const servizi = {
  cercaFermateCandidate:async ({richiestaIds}) => {assert.deepEqual(richiestaIds,[900001]);return candidati;},
  generaAssegnazioniFermate,
  valutaCombinazioniFermate:async ({combinazioni,departure}) => {
    assert.equal(departure,t);assert.equal(combinazioni.length,1);
    return {ok:true,valide:[{indice:0,kmMissione:0.869,combinazione:combinazioni[0]}],
      diagnostica:{valutazioneCompleta:true}};
  },
  adattaMissioneFermate:({alternativa,corridorId}) => {
    assert.equal(corridorId,'territorial:5>6');
    assert.equal(alternativa.combinazione.assegnazioni[0].salita.fermata_id,14);
    return {ok:true,nodi:[{id:14},{id:15}],missione:{nodes:[14,15],
      legs:[{metres:869,seconds:138,polyline:'fixture'}],departure:t,
      arrival:t+138000,requests:[{id:900001,start:0,end:1,posti_richiesti:2}]}};
  }
};
let pass=0;
async function test(label,fn) {await fn();console.log('PASS - '+label);pass++;}
await test('identita PIXEL e mapping fermate conservati',async()=>{
  const r=await bridge({client,formazione,richieste:[richiesta],postiTotali:4,servizi});
  assert.equal(r.ok,true);assert.equal(r.attivabile,false);
  assert.deepEqual(r.nodiTerritoriali,[5,6]);
  assert.deepEqual(r.alternativeFisiche[0].missione.nodes,[14,15]);
  assert.equal(r.pixelVersione,3);
});
await test('nessun filtro veicolo in assegnazione',async()=>{
  const r=await bridge({client,formazione,richieste:[richiesta],postiTotali:4,tipoVeicolo:'ncc',servizi});
  assert.equal(r.alternativeFisiche.length,1);
});
await test('nessuna fermata: esito non attivabile',async()=>{
  const r=await bridge({client,formazione,richieste:[richiesta],postiTotali:4,
    servizi:{...servizi,cercaFermateCandidate:async()=>[{richiesta_id:900001,salita:[],discesa:[]}]}});
  assert.equal(r.ok,false);assert.equal(r.alternativeFisiche.length,0);
});
await test('catalogo richieste incompleto rifiutato',async()=>{
  await assert.rejects(()=>bridge({client,formazione,richieste:[],postiTotali:4,servizi}),/catalogo|corrispondenti/);
});
await test('mapping fisico alterato rifiutato',async()=>{
  await assert.rejects(()=>bridge({client,formazione,richieste:[richiesta],postiTotali:4,
    servizi:{...servizi,adattaMissioneFermate:()=>({ok:true,missione:{requests:[{id:999999}]}})}}),/mapping/);
});
await test('nessuna query reale e nessuna attivazione',async()=>{
  const r=await bridge({client,formazione,richieste:[richiesta],postiTotali:4,servizi});
  assert.equal(r.attivabile,false);assert.equal(r.alternativeFisiche[0].attivabile,false);
});
console.log(`RISULTATO: ${pass} PASS, 0 FAIL. Mock SHADOW; DB 0 scritture; LIVE NO.`);
