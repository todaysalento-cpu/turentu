// TURENTU POPBUS V2 — Ottimizzazione temporale isolata, senza I/O e senza scritture.
// Collocare in services/popbus/v2/pixel-multimission-time-optimizer.js
const finite = v => v !== null && v !== undefined && Number.isFinite(Number(v));
const fail = s => { throw new Error(`PIXEL_TIME_OPTIMIZER: ${s}`); };

/**
 * Le finestre lower/upper DEVONO essere state calcolate dal chiamante come
 * intersezione della finestra PIXEL e delle tolleranze di tutte le richieste
 * ai rispettivi nodi di salita. Il modulo non crea direttrici o richieste.
 * movement restituisce il trasferimento stradale reale {metres,seconds}.
 * La funzione massimizza il margine temporale (A al più presto, B al più tardi),
 * non il profitto né la preferenza degli utenti dentro la finestra.
 */
export async function ottimizzaCoppiaTemporale({a,b,movement}={}) {
  if (!a || !b || typeof movement !== 'function') fail('argomenti mancanti');
  for (const [name,m] of [['A',a],['B',b]]) {
    if (![m.lower,m.upper,m.departure,m.arrival].every(finite)) fail(`orari ${name} non validi`);
    if (Number(m.lower)>Number(m.upper) || Number(m.departure)>=Number(m.arrival)) fail(`finestra ${name} non valida`);
    if (Number(m.departure)<Number(m.lower)-1 || Number(m.departure)>Number(m.upper)+1)
      fail(`partenza originale ${name} fuori finestra`);
    if (!m.from || !m.to || ![m.from.lat,m.from.lon,m.to.lat,m.to.lon].every(finite))
      fail(`coordinate ${name} non valide`);
    if (!Array.isArray(m.requests) || !m.requests.length) fail(`richieste ${name} mancanti`);
  }
  const ids=[...a.requests,...b.requests].map(r=>Number(r.id));
  if (ids.some(id=>!Number.isSafeInteger(id)||id<=0) || new Set(ids).size!==ids.length)
    return {stato:'RICHIESTE_DUPLICATE',fattibile:false};
  const transfer=await movement(a.to,b.from);
  if (!transfer || ![transfer.metres,transfer.seconds].every(finite) ||
      Number(transfer.metres)<0 || Number(transfer.seconds)<0) fail('routing non valido');
  const duration=Number(a.arrival)-Number(a.departure);
  const transferMs=Number(transfer.seconds)*1000;
  const originalMargin=Number(b.departure)-Number(a.arrival)-transferMs;
  const optimizedMargin=Number(b.upper)-Number(a.lower)-duration-transferMs;
  const result={
    stato: optimizedMargin < 0 ? 'TRASFERIMENTO_IMPOSSIBILE' :
      originalMargin < 0 ? 'RECUPERATA' : 'GIA_FATTIBILE',
    fattibile:optimizedMargin>=0,
    recuperata:originalMargin<0 && optimizedMargin>=0,
    margine_originale_min:Number((originalMargin/60000).toFixed(3)),
    margine_ottimizzato_min:Number((optimizedMargin/60000).toFixed(3)),
    trasferimento_km:Number(transfer.metres)/1000,
    trasferimento_min:Number(transfer.seconds)/60,
    partenza_a:Number(a.lower),partenza_b:Number(b.upper),
    missione_a:{...a,departure:Number(a.lower),arrival:Number(a.lower)+duration},
    missione_b:{...b,departure:Number(b.upper),arrival:Number(b.upper)+(Number(b.arrival)-Number(b.departure))}
  };
  return result;
}
