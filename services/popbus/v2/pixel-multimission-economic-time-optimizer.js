// TURENTU POPBUS V2 — pianificatore economico-temporale ISOLATO, puro salvo callback routing.
// Non legge/scrive DB, non modifica PIXEL, non attiva corse.
const valid = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const error = s => { throw new Error(`PIXEL_ECONOMIC_TIME_OPTIMIZER: ${s}`); };
const round = x => Math.round((x + Number.EPSILON) * 1000) / 1000;

/**
 * Missioni gia' validate dal chiamante. lower/upper: intersezione delle finestre
 * PIXEL e delle tolleranze delle richieste ai rispettivi nodi di salita (epoch ms).
 * Durate di missione e routing sono costanti rispetto alla partenza.
 * Questo modulo ottimizza SOLO il tempo di attesa fra DUE missioni; non modifica
 * prezzo, km, richieste o direttrici. Non certifica qualita', turni, conflitti, A/R.
 * validateShiftedMission deve riverificare ai nodi di salita la missione spostata.
 */
export async function ottimizzaAttesaDueMissioni({
  a,b,movement,validateShiftedMission,costoAttesaOraEuro=0
}={}) {
  if (!a || !b || typeof movement !== 'function' || typeof validateShiftedMission !== 'function') error('dipendenze mancanti');
  if (!valid(costoAttesaOraEuro) || Number(costoAttesaOraEuro)<0) error('costo attesa non valido');
  for (const [name,m] of [['A',a],['B',b]]) {
    if (![m.lower,m.upper,m.departure,m.arrival].every(valid) ||
      Number(m.lower)>Number(m.upper) || Number(m.departure)>=Number(m.arrival) ||
      Number(m.departure)<Number(m.lower) || Number(m.departure)>Number(m.upper)) error(`orari ${name} non validi`);
    if (!m.from || !m.to || ![m.from.lat,m.from.lon,m.to.lat,m.to.lon].every(valid)) error(`coordinate ${name} non valide`);
    if (!Array.isArray(m.requests) || !m.requests.length) error(`richieste ${name} mancanti`);
  }
  const ids=[...a.requests,...b.requests].map(r=>Number(r.id));
  if (ids.some(x=>!Number.isSafeInteger(x)||x<=0) || new Set(ids).size!==ids.length)
    return {stato:'RICHIESTE_DUPLICATE',fattibile:false};
  const transfer=await movement(a.to,b.from);
  if (!transfer || ![transfer.metres,transfer.seconds].every(valid) ||
    Number(transfer.metres)<0 || Number(transfer.seconds)<0) error('routing non valido');
  const durationA=Number(a.arrival)-Number(a.departure);
  const durationB=Number(b.arrival)-Number(b.departure);
  const transferMs=Number(transfer.seconds)*1000;
  const latestA=Math.min(Number(a.upper),Number(b.upper)-durationA-transferMs);
  if (latestA<Number(a.lower)) return {
    stato:'TRASFERIMENTO_IMPOSSIBILE',fattibile:false,
    deficit_min:round((Number(a.lower)+durationA+transferMs-Number(b.upper))/60000),
    trasferimento_km:round(Number(transfer.metres)/1000)
  };
  // A parte il piu' tardi possibile; B parte non appena il veicolo arriva,
  // salvo che la sua finestra inizi dopo. E' un ottimo del costo di attesa
  // con tariffa non negativa e durata di viaggio costante.
  const depA=latestA;
  const depB=Math.max(Number(b.lower),depA+durationA+transferMs);
  const waitMs=Math.max(0,depB-depA-durationA-transferMs);
  const shiftedA={...a,departure:depA,arrival:depA+durationA};
  const shiftedB={...b,departure:depB,arrival:depB+durationB};
  if (await validateShiftedMission(shiftedA,a)!==true ||
      await validateShiftedMission(shiftedB,b)!==true)
    return {stato:'VALIDAZIONE_NODI_FALLITA',fattibile:false};
  const originalWaitMs=Number(b.departure)-Number(a.arrival)-transferMs;
  return {
    stato:'FATTIBILE_TEMPORALMENTE',fattibile:true,
    recuperata:originalWaitMs<0,
    missione_a:shiftedA,missione_b:shiftedB,
    partenza_a:new Date(depA).toISOString(),partenza_b:new Date(depB).toISOString(),
    trasferimento_km:round(Number(transfer.metres)/1000),
    attesa_min:round(waitMs/60000),
    costo_attesa_euro:round(waitMs/3600000*Number(costoAttesaOraEuro)),
    margine_temporale_residuo_min:round((Number(b.upper)-depB)/60000),
    note:'Ottimo solo per attesa fra due missioni, non per ciclo globale o preferenze passeggeri'
  };
}
