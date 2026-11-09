const SAMPLE_SIZE = 500;
const CACHE_MS = 60_000;

export function createPaymentSample(pool, now = Date.now) {
  let pending;
  let cached;
  let expiresAt = 0;

  return function readPaymentSample() {
    if (pending) return pending;
    if (now() < expiresAt) return Promise.resolve(cached);
    pending = (async () => {
      try {
        const { rows: [row] } = await pool.query({
          text: `
            WITH recent AS (
              SELECT stato, stripe_payment_intent FROM public.pagamenti ORDER BY id DESC LIMIT $1
            )
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE stato = 'pendente')::int AS pending,
                   count(*) FILTER (WHERE stato = 'autorizzazione')::int AS authorized,
                   count(*) FILTER (WHERE stato = 'pagato')::int AS paid,
                   count(*) FILTER (WHERE stato = 'rimborsato')::int AS refunded,
                   count(*) FILTER (WHERE starts_with(stripe_payment_intent, 'pi_'))::int
                     - count(DISTINCT stripe_payment_intent)
                       FILTER (WHERE starts_with(stripe_payment_intent, 'pi_'))::int AS "duplicateIntentRows"
            FROM recent`,
          values: [SAMPLE_SIZE],
          query_timeout: 2_000,
        });
        cached = { ...row, limit: SAMPLE_SIZE, sampledAt: new Date(now()).toISOString() };
      } catch {
        cached = null;
      }
      expiresAt = now() + CACHE_MS;
      return cached;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
