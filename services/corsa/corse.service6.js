import { pool } from '../../db/db.js';
import Stripe from 'stripe';
import { calcolaPrezzo } from '../../utils/pricing.util.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ----------------------
// 1️⃣ Recupera corse per autista (status opzionale)
// ----------------------
export async function getCorseByAutista(driver_id, status = '') {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');

    let query = `
      SELECT
        c.id,
        c.veicolo_id,
        v.driver_id,
        v.modello AS veicolo,
        c.tipo_corsa,
        c.start_datetime,
        c.arrivo_datetime,
        c.durata,
        c.distanza,
        ST_Y(c.origine::geometry) AS origine_lat,
        ST_X(c.origine::geometry) AS origine_lon,
        ST_Y(c.destinazione::geometry) AS destinazione_lat,
        ST_X(c.destinazione::geometry) AS destinazione_lon,
        c.origine_address,
        c.destinazione_address,
        c."stato",
        c.prezzo_fisso AS prezzo,
        c.posti_disponibili,
        c.posti_totali,
        c.posti_prenotati
      FROM public.corse c
      JOIN public.veicolo v ON c.veicolo_id = v.id
      WHERE v.driver_id = $1
    `;

    const params = [driver_id];

    if (status === 'today') query += ` AND c.start_datetime::date = CURRENT_DATE`;
    else if (status === 'non_completate') query += ` AND c."stato" != 'completata'`;
    else if (status) {
      query += ` AND c."stato" = $2`;
      params.push(status);
    }

    query += ` ORDER BY c.start_datetime ASC`;

    const res = await client.query(query, params);

    return res.rows.map(c => ({
      id: c.id,
      veicolo_id: Number(c.veicolo_id),
      driver_id: Number(c.driver_id),
      veicolo: c.veicolo || 'N/D',
      tipo_corsa: c.tipo_corsa || 'N/D',
      stato: c.stato || 'N/D',
      prezzo: Number(c.prezzo) || 0,
      distanza: Number(c.distanza) || 0,
      posti_disponibili: Number(c.posti_disponibili) || 0,
      posti_totali: Number(c.posti_totali) || 0,
      posti_prenotati: Number(c.posti_prenotati) || 0,
      origine: c.origine_lat != null && c.origine_lon != null ? { lat: c.origine_lat, lon: c.origine_lon } : null,
      destinazione: c.destinazione_lat != null && c.destinazione_lon != null ? { lat: c.destinazione_lat, lon: c.destinazione_lon } : null,
      origine_address: c.origine_address || 'N/D',
      destinazione_address: c.destinazione_address || 'N/D',
      arrivo_datetime: c.arrivo_datetime ? new Date(c.arrivo_datetime) : null,
      durata: c.durata || null,
      ora: c.start_datetime ? new Date(c.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/D',
      data: c.start_datetime ? new Date(c.start_datetime).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'N/D',
    }));
  } finally {
    client.release();
  }
}

// ----------------------
// 2️⃣ Accetta corsa
// ----------------------
export async function accettaCorsa(corsa_id) {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');

    const res = await client.query(
      `UPDATE public.corse
       SET "stato" = 'accettata'
       WHERE id = $1
       RETURNING id, veicolo_id, start_datetime, tipo_corsa, durata, "stato", prezzo_fisso, arrivo_datetime,
                 distanza,
                 posti_disponibili, posti_totali, posti_prenotati, origine_address, destinazione_address`,
      [corsa_id]
    );

    const c = res.rows[0];
    if (!c) return null;

    return {
      id: c.id,
      veicolo_id: Number(c.veicolo_id),
      tipo_corsa: c.tipo_corsa,
      stato: c.stato,
      prezzo: Number(c.prezzo_fisso) || 0,
      distanza: Number(c.distanza) || 0,
      posti_disponibili: Number(c.posti_disponibili) || 0,
      posti_totali: Number(c.posti_totali) || 0,
      posti_prenotati: Number(c.posti_prenotati) || 0,
      arrivo_datetime: c.arrivo_datetime ? new Date(c.arrivo_datetime) : null,
      durata: c.durata || null,
      origine_address: c.origine_address || 'N/D',
      destinazione_address: c.destinazione_address || 'N/D',
    };
  } finally {
    client.release();
  }
}

// ----------------------
// 3️⃣ Inizia / Termina corsa + cattura pagamenti con log dettagliati
// ----------------------
export async function toggleCorsa(corsa_id, action) {
  if (!['start', 'end'].includes(action)) throw new Error('Azione non valida');

  const client = await pool.connect();

  try {
    console.log(`➡️ toggleCorsa START: corsa_id=${corsa_id}, action=${action}`);
    await client.query('BEGIN');
    await client.query('SET search_path TO public');

    const newStato = action === 'start' ? 'in_corso' : 'completata';

    // Aggiorno stato corsa
    const corsaRes = await client.query(
      `UPDATE public.corse
       SET "stato" = $1
       WHERE id = $2
       RETURNING id, veicolo_id, tipo_corsa, "stato", prezzo_fisso, arrivo_datetime, start_datetime, durata,
                 distanza,
                 posti_disponibili, posti_totali, posti_prenotati, origine_address, destinazione_address`,
      [newStato, corsa_id]
    );

    if (!corsaRes.rows.length) throw new Error(`Corsa con id ${corsa_id} non trovata`);

    const corsa = corsaRes.rows[0];
    console.log('🏁 Stato corsa aggiornato:', corsa);

    if (action === 'end') {
      // Recupero prenotazioni con pagamenti da catturare
      const prenRes = await client.query(
        `SELECT pr.id AS prenotazione_id, pr.posti_prenotati, p.id AS pagamento_id, p.stato AS pagamento_stato,
                p.stripe_payment_intent, p.importo
         FROM public.prenotazioni pr
         JOIN public.pagamenti p ON p.prenotazione_id = pr.id
         WHERE pr.corsa_id = $1 AND p.stato = 'autorizzazione'`,
        [corsa_id]
      );

      console.log(`🔹 Prenotazioni da catturare: ${prenRes.rows.length}`, prenRes.rows);

      for (const pren of prenRes.rows) {
        console.log('💳 Elaborando pagamento:', pren);

        if (!pren.stripe_payment_intent) {
          console.log('⚠️ Nessun stripe_payment_intent, salto pagamento_id=', pren.pagamento_id);
          continue;
        }

        // ⚡ Calcolo importo finale usando distanza reale
        let importoFinale = corsa.tipo_corsa === 'privata'
          ? parseFloat(pren.importo)
          : await calcolaPrezzo(
              {
                ...corsa,
                distanza: Number(corsa.distanza) || 0,
                posti_prenotati: corsa.posti_prenotati
              },
              pren.posti_prenotati,
              'prenotabile'
            );

        console.log(`💰 Importo finale per pagamento_id=${pren.pagamento_id}:`, importoFinale, 'DB importo originale:', pren.importo);

        try {
          const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
          console.log('💳 PaymentIntent status:', pi.status, 'amount:', pi.amount);

          if (pi.status === 'requires_capture') {
            await stripe.paymentIntents.capture(pren.stripe_payment_intent, {
              amount_to_capture: Math.round(importoFinale * 100),
            });

            await client.query(
              `UPDATE public.pagamenti
               SET stato = 'pagato', importo = $1, updated_at = NOW()
               WHERE id = $2`,
              [importoFinale, pren.pagamento_id]
            );
            console.log(`✅ Pagamento catturato e DB aggiornato pagamento_id=${pren.pagamento_id}`);
          } else {
            console.log(`❌ PaymentIntent non catturabile pagamento_id=${pren.pagamento_id}`);
            await client.query(
              `UPDATE public.pagamenti SET stato = 'fallito', updated_at = NOW() WHERE id = $1`,
              [pren.pagamento_id]
            );
          }
        } catch (err) {
          console.error(`💥 Errore cattura pagamento_id=${pren.pagamento_id}:`, err.message);
          await client.query(
            `UPDATE public.pagamenti SET stato = 'fallito', updated_at = NOW() WHERE id = $1`,
            [pren.pagamento_id]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log('🎯 toggleCorsa END commit completato');

    return {
      id: corsa.id,
      veicolo_id: Number(corsa.veicolo_id),
      tipo_corsa: corsa.tipo_corsa,
      stato: newStato,
      prezzo: Number(corsa.prezzo_fisso) || 0,
      distanza: Number(corsa.distanza) || 0,
      posti_disponibili: Number(corsa.posti_disponibili) || 0,
      posti_totali: Number(corsa.posti_totali) || 0,
      posti_prenotati: Number(corsa.posti_prenotati) || 0,
      arrivo_datetime: corsa.arrivo_datetime ? new Date(corsa.arrivo_datetime) : null,
      durata: corsa.durata || null,
      origine_address: corsa.origine_address || 'N/D',
      destinazione_address: corsa.destinazione_address || 'N/D',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('💥 toggleCorsa ERROR:', error.message, { corsa_id, action });
    throw error;
  } finally {
    client.release();
  }
}