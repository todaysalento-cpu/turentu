// TURENTU — diagnostica combinatoria pura, senza DB né routing.
// Replica l'ordine dei filtri preliminari del generatore a due missioni.
const fail = msg => { throw new Error('PIXEL_MULTIMISSION_PREFLIGHT: ' + msg); };
const validNum = (x, name) => { const n = Number(x); if (!Number.isFinite(n)) fail(name + ' non valido'); return n; };
export function analizzaCoppieMultiMissione({ missions, vehicles, now = Date.now(), maxChecks = 2000000 } = {}) {
  if (!Array.isArray(missions) || !Array.isArray(vehicles)) fail('array mancanti');
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 1) fail('maxChecks non valido');
  const ms = missions.map(m => ({
    departure: validNum(m.departure, 'departure'), arrival: validNum(m.arrival, 'arrival'),
    peak: validNum(m.peak, 'peak'),
    ids: new Set((m.requests || []).map(r => Number(r.id))),
    pixelOpportunitaId: Number(m.pixelOpportunitaId)
  }));
  if (ms.some(m => m.ids.size === 0 || !Number.isSafeInteger(m.pixelOpportunitaId))) fail('missione incompleta');
  const vs = vehicles.map(v => ({ capacity: validNum(v.posti_totali, 'posti_totali') }));
  const counts = { confronti: 0, esclusiTempo: 0, esclusiCapienza: 0,
    esclusiDuplicati: 0, coppieDaInstradare: 0 };
  const distinct = new Set();
  for (const v of vs) for (let i = 0; i < ms.length; i++) for (let j = 0; j < ms.length; j++) {
    if (++counts.confronti > maxChecks) fail('maxChecks superato: nessun risultato parziale');
    const a = ms[i], b = ms[j];
    if (i === j || a.arrival > b.departure || a.departure <= now) { counts.esclusiTempo++; continue; }
    if (a.peak > v.capacity || b.peak > v.capacity) { counts.esclusiCapienza++; continue; }
    if ([...a.ids].some(id => b.ids.has(id))) { counts.esclusiDuplicati++; continue; }
    counts.coppieDaInstradare++;
    distinct.add(i + ':' + j);
  }
  return { passed: true, shadow: true, dbWrites: 0, routingCalls: 0,
    missioni: ms.length, veicoli: vs.length,
    coppieDistintePrimaDeiVeicoli: distinct.size,
    ...counts, routingCallsPotenziali: counts.coppieDaInstradare * 3,
    nota: 'Stima prima del routing: non verifica trasferimento stradale, turni, conflitti, economia, vincoli A/R globali.' };
}
