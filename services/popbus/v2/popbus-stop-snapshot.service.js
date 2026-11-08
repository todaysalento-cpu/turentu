// Request-local stop candidates, scoped to one consistent read-only snapshot.
import { cercaFermateCandidate } from './popbus-stop-candidates.service.js';

const fail = message => { throw new Error(`POPBUS_STOP_SNAPSHOT: ${message}`); };
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const BATCH_SIZE = 200;

export function creaRicercaFermateSnapshot({client, richiestaIds, finder=cercaFermateCandidate}={}) {
  if (!client || typeof client.query !== 'function' || !Array.isArray(richiestaIds) ||
      richiestaIds.some(id=>!validId(id)) || typeof finder !== 'function')
    fail('contesto snapshot non valido');
  const ids=[...new Set(richiestaIds.map(Number))];
  const known=new Set(ids), groups=new Map();
  const diagnostica={queryContesto:0,queryFermate:0,caricamenti:0,lookup:0,bypass:0,
    richiestePrecaricate:0,fermateInCache:0,gruppiParametri:0,cedimentiEventLoop:0};
  let contextPromise, lastYield=performance.now();
  const checkContext=()=>contextPromise??=(async()=>{
    diagnostica.queryContesto++;
    const {rows}=await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only");
    if (!rows.length || !['repeatable read','serializable'].includes(rows[0].isolation) || rows[0].read_only!=='on')
      fail('richiesto snapshot coerente di sola lettura');
  })();
  const yieldIfNeeded=async()=>{
    if (performance.now()-lastYield<8) return;
    await new Promise(resolve=>setImmediate(resolve));lastYield=performance.now();diagnostica.cedimentiEventLoop++;
  };
  async function load(raggioMetri,limite) {
    await checkContext();
    const result=new Map();
    for(let offset=0;offset<ids.length;offset+=BATCH_SIZE){
      const batch=ids.slice(offset,offset+BATCH_SIZE),expected=new Set(batch);
      diagnostica.queryFermate++;
      const rows=await finder({client,richiestaIds:batch,raggioMetri,limite});
      if(!Array.isArray(rows)||rows.length!==batch.length)fail('risposta fermate incompleta');
      for(const row of rows){
        const id=Number(row?.richiesta_id);
        if(!expected.delete(id)||!Array.isArray(row.salita)||!Array.isArray(row.discesa))
          fail('risposta fermate incoerente');
        result.set(id,structuredClone(row));
      }
      if(expected.size)fail('richieste mancanti nella risposta fermate');
      await yieldIfNeeded();
    }
    diagnostica.caricamenti++;diagnostica.richiestePrecaricate+=result.size;
    diagnostica.fermateInCache+=[...result.values()].reduce((n,r)=>n+r.salita.length+r.discesa.length,0);
    return result;
  }
  async function cerca(args) {
    if(args?.client!==client)fail('client diverso dallo snapshot');
    const {richiestaIds:requested,raggioMetri,limite}=args;
    // Unsupported/invalid arguments still go through the original validator.
    // Explicit radius/limit are required for this optimization; defaults stay
    // owned by the original finder, not duplicated here.
    const eligible=Array.isArray(requested)&&requested.length>0&&requested.every(validId)&&
      Number.isFinite(raggioMetri)&&raggioMetri>0&&raggioMetri<=10000&&
      Number.isSafeInteger(limite)&&limite>=1&&limite<=30;
    if(!eligible||requested.some(id=>!known.has(Number(id)))){
      diagnostica.bypass++;return finder(args);
    }
    const key=JSON.stringify([raggioMetri,limite]);
    let pending=groups.get(key);
    if(!pending){pending=load(raggioMetri,limite);groups.set(key,pending);diagnostica.gruppiParametri=groups.size;}
    let saved;
    try{saved=await pending;}catch(error){if(groups.get(key)===pending)groups.delete(key);diagnostica.gruppiParametri=groups.size;throw error;}
    diagnostica.lookup++;await yieldIfNeeded();
    // The assignment/evaluator must not be able to mutate shared cached rows.
    return [...new Set(requested.map(Number))].map(id=>structuredClone(saved.get(id)));
  }
  return {cerca,diagnostica};
}
