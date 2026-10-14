// TURENTU POPBUS V2 — SERVICE QUALITY
// Modulo indipendente. Non modifica database, /search o stato richieste.
// Compatibile con il model.js aggiornato.
// ATTENZIONE: la verifica per nodi ripetuti richiede occorrenze esplicite.
import {
  classePercorrenza,
  QUALITA_PERCORRENZA,
  SOGLIE_PERCORRENZA_KM,
  verificaQualitaRichieste
} from './model.js';

const EPS = 1e-8;
const num = value => Number(value);
const finitePositive = value => Number.isFinite(num(value)) && num(value) > 0;
const directKm = r => {
  for (const k of ['distanza_diretta_km','distanzaKmDiretta','distanza_km_diretta']) {
    if (finitePositive(r[k])) return num(r[k]);
  }
  return null;
};

export { classePercorrenza, QUALITA_PERCORRENZA, SOGLIE_PERCORRENZA_KM };

// Per piani senza nodi ripetuti usa ESATTAMENTE le regole del model.js,
// evitando che due moduli applichino soglie differenti.
export function verificaQualita(plan, requests, options = {}) {
  return verificaQualitaRichieste(plan, requests, options);
}

// Verifica i cicli con nodi ripetuti mediante indici di OCCORRENZA.
// assignments: [{ richiesta: rowDB, start: indice, end: indice }]
// stops: indici delle fermate effettive. Se omessi sono le salite/discese
// delle richieste; non si contano i nodi di semplice transito.
// Non sostituisce il controllo di capienza e compatibilità temporale.
export function verificaQualitaOccorrenze(plan, assignments, options = {}) {
  if (!Array.isArray(plan?.nodes) || !Array.isArray(plan?.legs) ||
      plan.legs.length !== plan.nodes.length - 1 || !Array.isArray(assignments))
    return {ok:false,motivo:'PIANO_NON_VALIDO'};
  const metres=[0], seconds=[0];
  for (const l of plan.legs) {
    // Come in model.js: un segmento a zero e' ammesso solo se il routing
    // ha certificato esplicitamente la coincidenza stradale.
    const normale = finitePositive(l?.metres) && finitePositive(l?.seconds);
    const coincidente = l?.roadCoincident === true &&
      l.metres === 0 && l.seconds === 0;
    if (!normale && !coincidente)
      return {ok:false,motivo:'SEGMENTO_NON_VALIDO'};
    metres.push(metres.at(-1)+num(l.metres));
    seconds.push(seconds.at(-1)+num(l.seconds));
  }
  const stopSet=new Set();
  for (const a of assignments) {
    if (!a?.richiesta || !Number.isSafeInteger(a.start) ||
        !Number.isSafeInteger(a.end) || a.start<0 || a.end>=plan.nodes.length ||
        a.start>=a.end ||
        num(a.richiesta.start_node_id)!==num(plan.nodes[a.start]) ||
        num(a.richiesta.end_node_id)!==num(plan.nodes[a.end]))
      return {ok:false,motivo:'OCCORRENZA_NON_VALIDA',richiestaId:a?.richiesta?.id};
    stopSet.add(a.start);stopSet.add(a.end);
  }
  if (options.stops != null) {
    if (!Array.isArray(options.stops)) return {ok:false,motivo:'FERMATE_NON_VALIDE'};
    for (const i of options.stops) {
      if (!Number.isSafeInteger(i) || i<0 || i>=plan.nodes.length)
        return {ok:false,motivo:'FERMATA_NON_VALIDA'};
      stopSet.add(i);
    }
  }
  const stops=[...stopSet].sort((a,b)=>a-b);
  const dettagli=[];
  for (const a of assignments) {
    const r=a.richiesta;
    const km=(metres[a.end]-metres[a.start])/1000;
    // Un viaggio passeggeri interamente nullo non e' certificabile.
    if (km <= 0)
      return {ok:false,motivo:'TRATTA_PASSEGGERO_ZERO',richiestaId:r.id};
    const classe=classePercorrenza(r,km,options.sogliePercorrenza||SOGLIE_PERCORRENZA_KM);
    const defaults=(options.qualityConfig||QUALITA_PERCORRENZA)[classe];
    if (!defaults) return {ok:false,motivo:'CLASSE_NON_DETERMINABILE',richiestaId:r.id};
    const maxFermate=r.max_fermate_intermedie==null?defaults.maxFermate:num(r.max_fermate_intermedie);
    const minKm=r.min_km_tra_fermate==null?defaults.minKmTraFermate:num(r.min_km_tra_fermate);
    const maxDev=r.max_deviazione_pct==null?defaults.maxDeviazionePct:num(r.max_deviazione_pct);
    const maxDelay=r.max_ritardo_minuti==null?null:num(r.max_ritardo_minuti);
    if (![maxFermate,minKm,maxDev].every(Number.isFinite) ||
        !Number.isInteger(maxFermate) || maxFermate<0 || minKm<0 || maxDev<0 ||
        (maxDelay!=null && (!Number.isFinite(maxDelay)||maxDelay<0)))
      return {ok:false,motivo:'CONFIG_QUALITA_NON_VALIDA',richiestaId:r.id};
    const intermediate=stops.filter(i=>i>a.start && i<a.end);
    if (intermediate.length>maxFermate)
      return {ok:false,motivo:'TROPPE_FERMATE',richiestaId:r.id,fermate:intermediate.length,massimo:maxFermate};
    const sequence=[a.start,...intermediate,a.end];
    for (let i=1;i<sequence.length;i++) {
      const gap=(metres[sequence[i]]-metres[sequence[i-1]])/1000;
      if (intermediate.length && gap+EPS<minKm)
        return {ok:false,motivo:'FERMATE_TROPPO_VICINE',richiestaId:r.id,km:gap,minimoKm:minKm};
    }
    const direct=directKm(r);
    if (direct!=null && km>direct*(1+maxDev/100)+EPS)
      return {ok:false,motivo:'DEVIAZIONE_ECCESSIVA',richiestaId:r.id};
    if (maxDelay!=null && finitePositive(r.tempo_diretto_secondi) &&
        seconds[a.end]-seconds[a.start]>num(r.tempo_diretto_secondi)+maxDelay*60)
      return {ok:false,motivo:'RITARDO_ECCESSIVO',richiestaId:r.id};
    dettagli.push({richiestaId:num(r.id),classe,fermateIntermedie:intermediate.length,percorsoKm:km,start:a.start,end:a.end});
  }
  return {ok:true,dettagli};
}
