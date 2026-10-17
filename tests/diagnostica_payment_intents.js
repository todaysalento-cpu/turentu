
import 'dotenv/config';
import Stripe from 'stripe';
import { pool } from '../db/db.js';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('ERRORE: STRIPE_SECRET_KEY non presente nel file .env');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

function euro(centesimi) {
  return Number((Number(centesimi || 0) / 100).toFixed(2));
}

function classificazione(pi) {
  switch (pi.status) {
    case 'requires_capture':
      return 'AUTORIZZAZIONE_ATTIVA';

    case 'succeeded':
      return 'INCASSATO_STRIPE_DB_DA_VERIFICARE';

    case 'canceled':
      return 'ANNULLATO_STRIPE_DB_DA_VERIFICARE';

    case 'requires_payment_method':
      return 'METODO_PAGAMENTO_RICHIESTO';

    case 'requires_confirmation':
      return 'IN_ATTESA_CONFERMA';

    case 'requires_action':
      return 'AZIONE_CLIENTE_RICHIESTA';

    case 'processing':
      return 'PAGAMENTO_IN_ELABORAZIONE';

    default:
      return 'STATO_NON_CLASSIFICATO';
  }
}

async function main() {
  const risultati = [];
  let errori = 0;

  try {
    console.log('\n========================================');
    console.log('TURENTU - DIAGNOSTICA PAYMENT INTENTS');
    console.log('MODALITA: SOLA LETTURA');
    console.log('========================================\n');

    const { rows } = await pool.query(`
      SELECT
        p.id AS pagamento_id,
        p.corsa_id,
        p.prenotazione_id,
        p.stato AS stato_db,
        p.importo AS importo_db,
        p.stripe_payment_intent,
        p.updated_at,
        c.stato AS stato_corsa,
        c.start_datetime
      FROM public.pagamenti p
      JOIN public.corse c
        ON c.id = p.corsa_id
      WHERE p.stato = 'autorizzazione'
        AND c.start_datetime <= NOW()
      ORDER BY c.start_datetime, p.id
    `);

    console.log(`Pagamenti da verificare: ${rows.length}\n`);

    if (rows.length === 0) {
      console.log('Nessun pagamento da verificare.');
      return;
    }

    for (const p of rows) {
      if (!p.stripe_payment_intent) {
        errori++;

        risultati.push({
          pagamento_id: p.pagamento_id,
          corsa_id: p.corsa_id,
          prenotazione_id: p.prenotazione_id,
          stato_db: p.stato_db,
          stato_corsa: p.stato_corsa,
          importo_db: Number(p.importo_db),
          classificazione: 'PAYMENT_INTENT_MANCANTE',
          errore: 'ID Stripe assente',
        });

        continue;
      }

      try {
        // Soltanto lettura: nessuna cattura, cancellazione,
        // modifica del PaymentIntent o aggiornamento del database.
        const pi = await stripe.paymentIntents.retrieve(
          p.stripe_payment_intent
        );

        const classe = classificazione(pi);

        const risultato = {
          pagamento_id: p.pagamento_id,
          corsa_id: p.corsa_id,
          prenotazione_id: p.prenotazione_id,
          stato_corsa: p.stato_corsa,
          partenza: p.start_datetime,
          stato_db: p.stato_db,
          importo_db_euro: Number(p.importo_db),
          stripe_id: pi.id,
          stripe_status: pi.status,
          classificazione: classe,
          importo_autorizzato_euro: euro(pi.amount),
          importo_catturato_euro: euro(pi.amount_received),
          capture_method: pi.capture_method,
          valuta: pi.currency,
          creato_stripe: new Date(pi.created * 1000).toISOString(),
        };

        risultati.push(risultato);
        console.log(JSON.stringify(risultato));

      } catch (err) {
        errori++;

        const risultato = {
          pagamento_id: p.pagamento_id,
          corsa_id: p.corsa_id,
          stripe_id: p.stripe_payment_intent,
          classificazione: 'ERRORE_LETTURA_STRIPE',
          errore: err.message,
        };

        risultati.push(risultato);
        console.error(JSON.stringify(risultato));
      }
    }

    // Riepilogo per stato Stripe
    const gruppi = new Map();

    for (const r of risultati) {
      const classe = r.classificazione;

      if (!gruppi.has(classe)) {
        gruppi.set(classe, {
          classificazione: classe,
          totale: 0,
          importo_db_euro: 0,
          importo_autorizzato_euro: 0,
          importo_catturato_euro: 0,
        });
      }

      const g = gruppi.get(classe);
      g.totale++;

      g.importo_db_euro += Number(r.importo_db_euro || 0);
      g.importo_autorizzato_euro +=
        Number(r.importo_autorizzato_euro || 0);
      g.importo_catturato_euro +=
        Number(r.importo_catturato_euro || 0);
    }

    const riepilogo = [...gruppi.values()].map(g => ({
      ...g,
      importo_db_euro: Number(g.importo_db_euro.toFixed(2)),
      importo_autorizzato_euro:
        Number(g.importo_autorizzato_euro.toFixed(2)),
      importo_catturato_euro:
        Number(g.importo_catturato_euro.toFixed(2)),
    }));

    console.log('\n========================================');
    console.log('RIEPILOGO DIAGNOSTICA');
    console.log('========================================');

    console.table(riepilogo);

    console.log({
      record_letti: rows.length,
      payment_intents_letti:
        risultati.filter(r => r.stripe_status).length,
      errori: errori,
      modalita: 'SOLA LETTURA',
    });

    // Salva un rapporto locale JSON senza alterare i dati applicativi.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const directory = path.dirname(fileURLToPath(import.meta.url));
    const reportPath = path.join(
      directory,
      'diagnostica_payment_intents_report.json'
    );

    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          generato_il: new Date().toISOString(),
          modalita: 'SOLA LETTURA',
          totale_record: rows.length,
          errori,
          riepilogo,
          dettagli: risultati,
        },
        null,
        2
      ),
      'utf8'
    );

    console.log(`\nReport salvato in: ${reportPath}`);
    console.log('Nessuna modifica a PostgreSQL o Stripe.');

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Errore diagnostica:', err);
  process.exitCode = 1;
});
