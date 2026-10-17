import assert from 'node:assert/strict';
import {finestreRitornoPerNodo} from '../services/pixel/pixel-node-return-windows.js';
const t = h => Date.parse(`2026-10-20T${h}:00+02:00`);
const r=(id,s,e,time)=>({id,origine_nodo_territoriale_id:s,destinazione_nodo_territoriale_id:e,start_datetime:`2026-10-20T${time}:00+02:00`});
const andata={nodes:[6,5,7],legs:[{seconds:1800},{seconds:1800}],finestraPartenza:{inizioMs:t('09:00'),fineMs:t('09:00')}};
const ritorni=new Map([
 [5,{nodes:[5,6],legs:[{seconds:1800}]}],
 [7,{nodes:[7,5,6],legs:[{seconds:1800},{seconds:1800}]}]
]);
const result=finestreRitornoPerNodo({andata,ritorniPerInversione:ritorni,
 richieste:[r(1,5,6,'09:40'),r(2,5,6,'10:40'),r(3,7,5,'10:10')],
 tolleranzaMinuti:15,bufferMinuti:10});
const maglie=result.get(5);
assert.equal(maglie.length,3);
assert.deepEqual(maglie.map(x=>x.inversioneNodoId),[5,5,7]);
assert.deepEqual(maglie[0].richiestaIds,[1]);
assert.deepEqual(maglie[1].richiestaIds,[2]);
assert.deepEqual(maglie[2].richiestaIds,[2,3]);
assert.equal(maglie[0].finestraPassaggio.inizioMs,t('09:40'));
assert.equal(maglie[2].finestraPassaggio.inizioMs,t('10:40'));
assert.equal(result.get(7).length,1);
assert.equal(result.get(6).length,0);
assert.equal(finestreRitornoPerNodo({andata,ritorniPerInversione:new Map(),richieste:[]}).get(5).length,0);
assert.throws(()=>finestreRitornoPerNodo({andata,ritorniPerInversione:new Map([[7,{nodes:[7,6,5],legs:[{seconds:100},{seconds:100}]}]])}));
console.log('PIXEL NODE RETURN: 9 test superati; nessuna scrittura DB');
