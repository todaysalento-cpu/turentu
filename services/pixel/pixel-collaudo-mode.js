// Abilitazione esclusivamente server-side. Non leggere parametri dal client.
export function pixelCollaudoEnabled() {
  return process.env.PIXEL_TEST_MODE === 'true' &&
    String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');
}
