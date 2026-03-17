// ======================= test_cattura_stripe_multi.js =======================
import 'dotenv/config';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { calcolaPrezzo } from '../utils/pricing.util.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

const corseDaTest = [394, 395, 389, 428]; // corsa_id con prenotazioni >1 in autorizzazione

async function catturaPagamenti(corseIds) {
  const client = await pool.connect();

  try {
    for (const corsaId of corseIds) {
      const { rows: prenotazioni } = await client.query(
        `SELECT pr.id AS prenotazione_id, pr.posti_prenotati, p.id AS pagamento_id, p.stripe_payment_intent
         FROM prenotazioni pr
         JOIN pagamenti p ON p.prenotazione_id = pr.id
         WHERE pr.corsa_id=$1 AND p.stato='autorizzazione'`,
        [corsaId]
      );

      if (prenotazioni.length === 0) {
        console.log(`⚠️ Nessuna prenotazione da catturare per corsa ${corsaId}`);
        continue;
      }

      const { rows: corsaRes } = await client.query(
        `SELECT id, veicolo_id, distanza, posti_prenotati, primo_posto
         FROM corse
         WHERE id = $1`,
        [corsaId]
      );

      if (!corsaRes[0]) {
        console.warn(`⚠️ Corsa ${corsaId} non trovata`);
        continue;
      }

      const corsa = corsaRes[0];
      corsa.distanza = parseFloat(corsa.distanza || 0);

      console.log(`🚀 Corsa ${corsaId}: ${prenotazioni.length} prenotazioni da catturare, distanza=${corsa.distanza} km`);

      for (const p of prenotazioni) {
        try {
          const prezzoFinale = await calcolaPrezzo(
            { ...corsa, distanza: corsa.distanza, posti_prenotati: corsa.posti_prenotati, primo_posto: corsa.primo_posto },
            p.posti_prenotati,
            'prenotabile'
          );

          const amount = Math.round(prezzoFinale * 100);

          console.log(`💰 Cattura prenotazione ${p.prenotazione_id}: prezzoFinale=${prezzoFinale}€, amount=${amount}c`);

          await stripe.paymentIntents.capture(p.stripe_payment_intent, { amount_to_capture: amount });

          await client.query(
            `UPDATE pagamenti
             SET stato='pagato', importo=$1, updated_at=NOW()
             WHERE id=$2`,
            [prezzoFinale, p.pagamento_id]
          );

          console.log(`✅ Prenotazione ${p.prenotazione_id} catturata correttamente.`);
        } catch (err) {
          console.error(`❌ Errore cattura prenotazione ${p.prenotazione_id}:`, err.message);
        }
      }
    }

    console.log('💥 Test cattura completato per tutte le corse.');
  } finally {
    client.release();
  }
}

catturaPagamenti(corseDaTest)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Errore script test:', err);
    process.exit(1);
  });