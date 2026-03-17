/**
 * Simulazione della libreria Stripe per test senza chiamare realmente Stripe
 */
export default class StripeMock {
  constructor() {
    // Mock dei metodi che userai, come paymentIntents.create() e capture()
    this.paymentIntents = {
      create: async ({ amount, currency, capture_method, metadata }) => {
        console.log(`[MOCK STRIPE] create PaymentIntent: ${amount} ${currency}, capture_method=${capture_method}`);
        // Simula una creazione di PaymentIntent con un ID fittizio
        return { id: 'pi_mock_12345', amount, currency, capture_method, metadata };
      },
      capture: async (id, { amount_to_capture }) => {
        console.log(`[MOCK STRIPE] capture PaymentIntent ${id}, amount=${amount_to_capture}`);
        return { id, status: 'succeeded' }; // Simula una riuscita della capture
      }
    };
  }
}
