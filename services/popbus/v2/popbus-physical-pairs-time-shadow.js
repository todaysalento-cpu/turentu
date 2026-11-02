const finite = x => typeof x === 'number' && Number.isFinite(x);

export function diagnosticaCoppieFisicheTemporaliShadow({ finestre } = {}) {
  if (!Array.isArray(finestre)) throw new Error('PAIR_TIME_SHADOW: finestre non valide');
  const gruppi = new Map();
  for (const x of finestre) {
    const c = x.candidato, t = x.temporalShadow;
    if (!Number.isSafeInteger(c?.vehicleId) || c.vehicleId <= 0 || !Number.isSafeInteger(c?.pixelOpportunitaId) || !Array.isArray(c?.requests) || !t) throw new Error('PAIR_TIME_SHADOW: candidato non valido');
    if (!gruppi.has(c.vehicleId)) gruppi.set(c.vehicleId, []);
    gruppi.get(c.vehicleId).push(x);
  }
  const stats = { veicoli:gruppi.size, coppieStessoVeicolo:0, richiesteCondivise:0, finestreNonValide:0, incompatibiliTemporalmente:0, compatibiliTeoricamente:0, trasferimentoStradaleVerificato:false, recuperabileValidato:false, attivabile:false };
  for (const elementi of gruppi.values()) {
    const ordinate = elementi.slice().sort((a,b) => a.candidato.pixelOpportunitaId - b.candidato.pixelOpportunitaId);
    for (let i=0; i<ordinate.length; i++) for (let j=i+1; j<ordinate.length; j++) {
      const a=ordinate[i], b=ordinate[j];
      if (a.candidato.pixelOpportunitaId === b.candidato.pixelOpportunitaId) continue;
      stats.coppieStessoVeicolo++;
      const idsA = new Set(a.candidato.requests.map(r => Number(r.id)));
      if (b.candidato.requests.some(r => idsA.has(Number(r.id)))) { stats.richiesteCondivise++; continue; }
      const fa=a.temporalShadow, fb=b.temporalShadow;
      if (!fa.ok || !fb.ok || !finite(fa.lower) || !finite(fa.upper) || !finite(fb.lower) || !finite(fb.upper) || !finite(fa.durataMs) || fa.durataMs<=0 || fa.lower>fa.upper || fb.lower>fb.upper) { stats.finestreNonValide++; continue; }
      const primaPartenzaB = Math.max(fb.lower,fa.lower+fa.durataMs);
      if (primaPartenzaB<=fb.upper) stats.compatibiliTeoricamente++; else stats.incompatibiliTemporalmente++;
    }
  }
  return stats;
}
