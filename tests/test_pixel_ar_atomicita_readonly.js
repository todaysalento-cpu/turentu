// TURENTU — contratto di selezione atomica A/R, test isolato READ ONLY.
// Non modifica POPBUS: verifica la policy desiderata su candidati sintetici
// e l'integrazione con l'ottimizzatore flotta esistente.
import assert from 'node:assert/strict';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.js';

const pairs = new Map([
  ['AR_MARIO', new Set([101, 201])],
  ['AR_ANNA', new Set([102, 202])],
]);
const ordinary = new Set([11, 12, 21]);
const allowed = new Set([...ordinary, ...[...pairs.values()].flatMap(s => [...s])]);
const vehicle = 361;
const at = h => `2027-01-10T${h}:00Z`;
const cycle = (id, requests, margin, from='08:00', to='13:00') => ({
  id, veicolo:vehicle, richieste:requests,
  partenza_base:at(from), ritorno_base:at(to),
  margine_ciclo_con_attesa_euro:margin
});

// Gate: una richiesta A/R contribuisce solo se entrambe le sue tratte
// sono presenti NELLO STESSO PIANO DI ATTIVAZIONE. Un piano puo contenere
// piu missioni/cicli distinti, attivati congiuntamente.
function validaPiano(candidati) {
  const selected = new Set();
  for (const c of candidati) {
    for (const id of c.richieste) {
      if (!allowed.has(id)) return {ok:false, reason:'RICHIESTA_SCONOSCIUTA'};
      if (selected.has(id)) return {ok:false, reason:'RICHIESTA_DUPLICATA'};
      selected.add(id);
    }
  }
  for (const [groupId, ids] of pairs) {
    const n = [...ids].filter(id => selected.has(id)).length;
    if (n !== 0 && n !== ids.size) return {ok:false, reason:'AR_PARZIALE', groupId};
  }
  return {ok:true, selected};
}
function selezionaAtomicamente(candidati) {
  // Ricerca esaustiva limitata: il test certifica la regola, NON un algoritmo
  // di produzione scalabile. Il fleet optimizer valida i vincoli di flotta.
  assert.ok(candidati.length <= 15, 'fixture troppo grande');
  let best = {margine:0, selezionati:[], ottimo:null};
  for (let mask=0; mask<(1<<candidati.length); mask++) {
    const subset = candidati.filter((_,i)=>mask & (1<<i));
    if (!validaPiano(subset).ok) continue;
    const opt = ottimizzaFlotta(subset);
    // Nessun ciclo puo essere scartato dall'ottimizzatore, altrimenti
    // potrebbe restare soltanto una meta di una richiesta A/R.
    if (opt.cicliSelezionati !== subset.length) continue;
    if (opt.limiteNodiRaggiunto || opt.candidatiTagliati) continue;
    const margine = subset.reduce((s,c)=>s+c.margine_ciclo_con_attesa_euro,0);
    if (margine > best.margine) best = {margine,selezionati:subset,ottimo:opt};
  }
  return best;
}
let passed=0;
function check(name, ok) {assert.ok(ok,name); console.log('PASS',name); passed++;}

const out = cycle('ANDATA_ORDINARIA',[11,12],20,'08:00','10:00');
const back = cycle('RITORNO_ORDINARIO',[21],15,'11:00','13:00');
const onlyOut = cycle('ANDATA_CON_MARIO',[11,12,101],36,'08:00','10:00');
const onlyBack = cycle('RITORNO_CON_MARIO',[21,201],28,'11:00','13:00');
const annaOut = cycle('ANDATA_CON_ANNA',[11,12,102],37,'08:00','10:00');
const annaBackLate = cycle('RITORNO_ANNA_TARDI',[202],24,'18:00','20:00');

check('richieste ordinarie indipendenti',validaPiano([out]).ok && validaPiano([back]).ok);
check('andata A/R isolata esclusa',validaPiano([onlyOut]).reason==='AR_PARZIALE');
check('ritorno A/R isolato escluso',validaPiano([onlyBack]).reason==='AR_PARZIALE');
check('A/R completo in due missioni ammesso',validaPiano([onlyOut,onlyBack]).ok);
check('A/R Anna non puo contribuire senza ritorno',validaPiano([annaOut]).reason==='AR_PARZIALE');
check('duplicazione fra missioni respinta',validaPiano([out,onlyOut]).reason==='RICHIESTA_DUPLICATA');

const plan1=selezionaAtomicamente([out,back,onlyOut]);
check('se manca ritorno vincolato vince piano ordinario',plan1.selezionati.length===2 && plan1.margine===35);
check('nessuna richiesta A/R conteggiata nel piano ordinario',validaPiano(plan1.selezionati).ok && !plan1.selezionati.some(c=>c.richieste.includes(101)));
const plan2=selezionaAtomicamente([out,back,onlyOut,onlyBack]);
check('A/R congiunto ammesso anche su missioni distinte',plan2.selezionati.length===2 && plan2.margine===64);
check('ottimizzatore rispetta assenza conflitti veicolo',plan2.ottimo?.cicliSelezionati===2);

// Ritorno Anna troppo tardi: la policy A/R da sola non controlla
// finestre di ciclo. Deve esserci un gate temporale separato.
const compatibleReturnWindow=(a,r,maxWaitMin=90)=>{
  const wait=(Date.parse(r.partenza_base)-Date.parse(a.ritorno_base))/60000;
  return wait>=0 && wait<=maxWaitMin;
};
check('ritorno fuori finestra rilevato',!compatibleReturnWindow(annaOut,annaBackLate));
check('compatibilita temporale non implicita in atomicita',validaPiano([annaOut,annaBackLate]).ok);

console.log('PIXEL_AR_ATOMICITA_READONLY_JSON:'+JSON.stringify({passed:true,test:passed,dbWrites:0,
  margineOrdinario:plan1.margine,margineCongiunto:plan2.margine,
  nota:'Policy simulata nel test: NON prova che il worker POPBUS applichi gia il gate A/R; finestre e attivazione DB richiedono test dedicati.'}));
