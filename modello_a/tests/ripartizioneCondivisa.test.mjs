import test from 'node:test';
import assert from 'node:assert/strict';
import { ripartisciCondivisa, verificaIngressoCondivisa } from '../ripartizioneCondivisa.util.js';
const quota = (id, km_utente, posti_richiesti=1) => ({id,km_utente,posti_richiesti});
test('una prenotazione paga il costo totale',()=>{
  assert.equal(ripartisciCondivisa({costoCommercialeCentesimi:10001,prenotazioni:[quota(1,100)]})[0].quotaCentesimi,10001);
});
test('ripartizione proporzionale e centesimi esatti',()=>{
  const r=ripartisciCondivisa({costoCommercialeCentesimi:10000,prenotazioni:[quota(1,100),quota(2,50)]});
  assert.deepEqual(r.map(x=>x.quotaCentesimi),[6667,3333]);
  assert.equal(r.reduce((a,p)=>a+p.quotaCentesimi,0),10000);
});
test('posti moltiplicano il peso',()=>{
  const r=ripartisciCondivisa({costoCommercialeCentesimi:9000,prenotazioni:[quota(1,100,2),quota(2,100,1)]});
  assert.deepEqual(r.map(x=>x.quotaCentesimi),[6000,3000]);
});
test('aggiunta passeggero riduce quota esistente',()=>{
  const before=ripartisciCondivisa({costoCommercialeCentesimi:10000,prenotazioni:[quota(1,100)]});
  const after=ripartisciCondivisa({costoCommercialeCentesimi:10000,prenotazioni:[quota(1,100),quota(2,100)]});
  assert.deepEqual(verificaIngressoCondivisa({quotePrecedenti:before,quoteNuove:after,massimaliCentesimi:[{id:1,massimoCentesimi:10000},{id:2,massimoCentesimi:10000}]}),{ammissibile:true,violazioni:[]});
});
test('non ammette quota superiore a massimale',()=>{
  const r=ripartisciCondivisa({costoCommercialeCentesimi:10000,prenotazioni:[quota(1,100),quota(2,100)]});
  assert.equal(verificaIngressoCondivisa({quotePrecedenti:[],quoteNuove:r,massimaliCentesimi:[{id:1,massimoCentesimi:4000},{id:2,massimoCentesimi:6000}]}).ammissibile,false);
});
test('rifiuta km zero o negativi',()=>{
  assert.throws(()=>ripartisciCondivisa({costoCommercialeCentesimi:100,prenotazioni:[quota(1,0)]}),/Km non validi/);
});
test('un centesimo non garantisce risparmio a ogni ingresso',()=>{
  const before=ripartisciCondivisa({costoCommercialeCentesimi:1,prenotazioni:[quota(1,100)]});
  const after=ripartisciCondivisa({costoCommercialeCentesimi:1,prenotazioni:[quota(1,100),quota(2,100)]});
  assert.equal(verificaIngressoCondivisa({quotePrecedenti:before,quoteNuove:after,massimaliCentesimi:[{id:1,massimoCentesimi:1},{id:2,massimoCentesimi:1}]}).ammissibile,false);
});
