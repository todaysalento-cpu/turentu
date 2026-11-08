// Bounded snapshot size. Downstream formation, vehicle and routing budgets remain mandatory.
export function leggiLimiteOpportunita(env = process.env) {
  const raw = env.POPBUS_PIXEL_MAX_OPPORTUNITA ?? 64;
  const value = Number(raw);
  if (raw === '' || typeof raw === 'boolean' || !Number.isSafeInteger(value) || value < 1 || value > 999)
    throw new Error('POPBUS_PIXEL_MAX_OPPORTUNITA: intero da 1 a 999 obbligatorio');
  // The reader accepts at most 1000: reserve one row to detect overflow.
  return value;
}
