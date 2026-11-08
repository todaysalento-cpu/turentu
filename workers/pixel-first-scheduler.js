// Process-local lifecycle: stopping never cancels an application transaction.
export function createPixelFirstScheduler({schedule,run,logger=console}) {
  let task=null,active=null,stopping=false,generation=0,last=null,stopPromise=null;
  const status=()=>({scheduled:task!==null,running:active!==null,stopping,last,scope:'PROCESS_LOCAL',pid:process.pid});
  function start() {
    if(stopping || active) throw new Error('PIXEL_WORKER_DRAINING');
    if(task) return status();
    const token=++generation;
    task=schedule('* * * * *',()=>{
      if(!task || stopping || token!==generation || active) return;
      const started=performance.now();
      active=Promise.resolve().then(run).then(()=>{
        last={ok:true,durationMs:Math.round(performance.now()-started),finishedAt:new Date().toISOString()};
      },error=>{
        last={ok:false,durationMs:Math.round(performance.now()-started),finishedAt:new Date().toISOString()};
        logger.error('[PIXEL FIRST WORKER] ERRORE:',error?.stack||error);
      }).finally(()=>{active=null;});
      return active;
    },{noOverlap:true});
    return status();
  }
  function stop({waitMs=10000}={}) {
    if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>30000) throw new Error('PIXEL_WORKER_WAIT_INVALID');
    if(stopPromise) return stopPromise;
    // Invalidate even callbacks already queued before destroy().
    ++generation;
    const previous=task;task=null;stopping=true;
    stopPromise=Promise.resolve().then(async()=>{try {
      if(previous) await previous.destroy();
      if(active && waitMs>0) {
        let timer;
        try {await Promise.race([active,new Promise(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
        finally {clearTimeout(timer);}
      }
    } finally {stopping=false;stopPromise=null;}
    return status();});
    return stopPromise;
  }
  return {start,stop,status};
}
