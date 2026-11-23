const MINUTE = 60000;
const AIRPORT_BUFFER = 90 * MINUTE;
const STOP_DURATION = 2 * MINUTE;
const MAX_DETOUR = 0.25;
const MAX_STOPS = 4;

const normalize = value => value.trim().replace(/\s+/g, ' ').toLowerCase();

export function creaVerificaMultisalita(calcolaTratta, now = Date.now()) {
  const legs = new Map();
  const deadline = now + 12000;
  async function leg(from, to) {
    const key = JSON.stringify([normalize(from), normalize(to)]);
    if (!legs.has(key)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || legs.size >= 48) return null;
      legs.set(key, new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), remaining);
        Promise.resolve().then(() => calcolaTratta(from, to)).then(resolve, () => resolve(null))
          .finally(() => clearTimeout(timer));
      }));
    }
    const result = await legs.get(key);
    return result?.distanzaKm > 0 && Number.isFinite(result.distanzaKm) &&
      result.durataMs > 0 && Number.isFinite(result.durataMs) ? result : null;
  }

  return async function verifica(rows, tolleranzaMinuti) {
    const { destinazione, volo_programmato_il } = rows[0];
    const latestAirport = new Date(volo_programmato_il).getTime() - AIRPORT_BUFFER;
    if (!(latestAirport > now)) return null;
    const stops = new Map();
    const tolerance = tolleranzaMinuti * MINUTE;
    for (const row of rows) {
      const time = new Date(row.prelievo_il).getTime();
      if (!Number.isFinite(time)) return null;
      const point = normalize(row.origine);
      const stop = stops.get(point) ?? { localita: row.origine, from: now, to: Infinity, prenotazioni: [] };
      stop.from = Math.max(stop.from, time - tolerance);
      stop.to = Math.min(stop.to, time + tolerance);
      stop.prenotazioni.push(row.id);
      stops.set(point, stop);
    }
    const points = [...stops.values()];
    if (points.length > MAX_STOPS || points.some(stop => stop.from > stop.to)) return null;
    const matrix = await Promise.all(points.map(from => Promise.all([
      ...points.map(to => to === from ? null : leg(from.localita, to.localita)),
      leg(from.localita, destinazione)
    ])));
    let best = null;
    function visit(order, itinerary, time, km) {
      const last = order.at(-1);
      if (order.length === points.length) {
        const end = matrix[last][points.length];
        if (!end) return;
        const arrival = time + end.durataMs;
        const total = km + end.distanzaKm;
        if (arrival > latestAirport || (best && total >= best.km)) return;
        let deviation = 0;
        for (const [index, point] of order.entries()) {
          const direct = matrix[point][points.length];
          if (!direct) return;
          deviation = Math.max(deviation, (total - itinerary[index].km) / direct.distanzaKm - 1);
        }
        if (deviation > MAX_DETOUR + 1e-9) return;
        best = {
          km: total, deviazionePercentuale: Math.round(deviation * 100),
          arrivoPrevisto: new Date(arrival).toISOString(),
          fermate: itinerary.map(({ localita, prelievo, prenotazioni }) => ({
            localita, prelievo: new Date(prelievo).toISOString(), prenotazioni
          }))
        };
        return;
      }
      for (const [index, stop] of points.entries()) {
        if (order.includes(index)) continue;
        const segment = last == null ? { durataMs: 0, distanzaKm: 0 } : matrix[last][index];
        if (!segment) continue;
        const pickup = Math.max(stop.from, time + segment.durataMs);
        if (pickup > stop.to || pickup > latestAirport) continue;
        const nextKm = km + segment.distanzaKm;
        visit([...order, index], [...itinerary, { ...stop, prelievo: pickup, km: nextKm }], pickup + STOP_DURATION, nextKm);
      }
    }
    visit([], [], now, 0);
    return best;
  };
}
