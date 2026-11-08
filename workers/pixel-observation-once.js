import {pool} from '../db/db.js';
import {leg} from '../services/popbus/v2/planner.js';
import polyline from 'polyline';
import {processaPixelFirstMultimissione} from '../services/popbus/v2/pixel-first-multimission-service.js';
import {getPixelFirstWorkerStatus} from './popbus-pixel-first.worker.js';

const fault=code=>Object.assign(new Error(code),{code,status:409});
export function createPixelObservationOnce({execute,route,workerStatus,env=process.env,clock=()=>performance.now()}) {
 let used=false,state={state:'IDLE',scope:'PROCESS_LOCAL',pid:process.pid},completion=null;
 const status=()=>structuredClone(state);
 function start() {
  if(env.POPBUS_PIXEL_OBSERVATION_ONCE_ALLOWED!=='1' ||
     env.POPBUS_PIXEL_FIRST_ENABLED!=='false' || env.POPBUS_PIXEL_FIRST_MODE!=='ROLLBACK_ONLY' ||
     env.POPBUS_WORKER_ENABLED!=='false' ||
     ['POPBUS_PIXEL_FIRST_LIVE_APPROVED','PIXEL_FIRST_PIPELINE_LIVE_APPROVED','PIXEL_OPERATIONAL_LIVE_APPROVED'].some(k=>env[k]!=='0'))
    throw fault('PIXEL_OBSERVATION_NOT_AUTHORIZED');
  if(used)throw fault('PIXEL_OBSERVATION_ALREADY_USED');
  const worker=workerStatus();if(worker.scheduled||worker.running||worker.stopping)throw fault('PIXEL_OBSERVATION_WORKER_ACTIVE');
  const text=env.POPBUS_PIXEL_OBSERVATION_IDS??'';
  if(!/^[1-9]\d*(,[1-9]\d*)?$/.test(text))throw fault('PIXEL_OBSERVATION_IDS_INVALID');
  const ids=text.split(',').map(Number);
  if(ids.some(x=>!Number.isSafeInteger(x))||new Set(ids).size!==ids.length)throw fault('PIXEL_OBSERVATION_IDS_INVALID');
  const limit=Number(env.POPBUS_PIXEL_OBSERVATION_ROUTING_LIMIT??8);
  if(!Number.isSafeInteger(limit)||limit<1||limit>8)throw fault('PIXEL_OBSERVATION_BUDGET_INVALID');
  used=true;const started=clock(),cache=new Map();let reserved=0,blocked=null;
  state={...state,state:'RUNNING',opportunityIds:ids,routingLimit:limit,routingReservations:0};
  // A reservation is conservative: planner cache hits may avoid the real provider.
  const boundedRouting=async(a,b)=>{
   const key=JSON.stringify([a.lat,a.lon,b.lat,b.lon]);
   if(cache.has(key))return cache.get(key);
   if(clock()-started>=30000){blocked='PIXEL_OBSERVATION_ROUTING_DEADLINE';throw fault(blocked);}
   if(reserved>=limit){blocked='PIXEL_OBSERVATION_ROUTING_BUDGET';throw fault(blocked);}
   reserved++;state.routingReservations=reserved;
   const pending=Promise.resolve().then(()=>route(a,b));cache.set(key,pending);return pending;
  };
  completion=Promise.resolve().then(()=>execute({mode:'ROLLBACK_ONLY',physicalShadow:true,
   physicalCycleShadow:true,physicalOpportunityIds:ids,physicalShadowRouting:boundedRouting})).then(result=>{
    const complete=!blocked && result?.diagnostica?.completo===true && result.parziale!==true;
    state={...state,state:complete?'COMPLETED':'INCOMPLETE',complete,
     reason:blocked??(complete?null:'PIXEL_OBSERVATION_INCOMPLETE'),
     physicalCandidates:result?.missioniCandidateFisiche??0,dbWrites:result?.dbWrites??null};
    // Never accept a write result as an observational success.
    if(result?.dbWrites!==0||result?.persistita===true){state.state='FAILED';state.complete=false;state.reason='PIXEL_OBSERVATION_WRITE_CONTRACT';}
   },()=>{state={...state,state:'FAILED',complete:false,reason:blocked??'PIXEL_OBSERVATION_FAILED'};})
   .finally(()=>{state.durationMs=Math.round(clock()-started);});
  return status();
 }
 return {start,status,settled:()=>completion};
}
const observer=createPixelObservationOnce({
 execute:args=>processaPixelFirstMultimissione({pool,...args}),
 workerStatus:getPixelFirstWorkerStatus,
 route:(a,b)=>Math.abs(Number(a.lat)-Number(b.lat))<1e-7 && Math.abs(Number(a.lon)-Number(b.lon))<1e-7
  ? {metres:0,seconds:0,polyline:polyline.encode([[Number(a.lat),Number(a.lon)],[Number(a.lat),Number(a.lon)]]),roadCoincident:true}
  : leg(a,b)
});
export const startPixelObservationOnce=()=>observer.start();
export const getPixelObservationOnceStatus=()=>observer.status();
