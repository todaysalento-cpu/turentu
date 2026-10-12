// Intervalli semiaperti: chi scende a una fermata libera posti per chi sale lì.
export function calcolaPicco(intervalli, da = -Infinity, a = Infinity) {
  const eventi = new Map();
  for (const r of intervalli) {
    const start = Number(r.start), end = Number(r.end), posti = Number(r.posti);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
        !Number.isInteger(posti) || posti <= 0) throw new Error('Intervallo di occupazione non valido');
    const left = Math.max(start, da), right = Math.min(end, a);
    if (left >= right) continue;
    eventi.set(left, (eventi.get(left) || 0) + posti);
    eventi.set(right, (eventi.get(right) || 0) - posti);
  }
  let presenti = 0, picco = 0;
  for (const [, delta] of [...eventi].sort((x,y) => x[0]-y[0])) {
    presenti += delta; picco = Math.max(picco,presenti);
  }
  return picco;
}
