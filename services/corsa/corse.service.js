import { pool } from '../../db/db.js';
import Stripe from 'stripe';
import { getTariffe, calcolaPrezzo } from '../../utils/pricing.util.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { upsertCorsa, removeCorsa } from '../search/search.cache.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ===================== HELPERS ===================== */
export function parseDurataMinuti(durata) {
  if (!durata) return 0;
  if (typeof durata === 'number') return durata;
  if (typeof durata === 'string') {
    const parts = durata.split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }
  return 0;
}

/* ===================== 1️⃣ CORSE PER AUTISTA ===================== */
export async function getCorseByAutista(driver_id, status = '') {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');
    let query = `SELECT c.*, v.driver_id, v.modello AS veicolo FROM public.corse c JOIN public.veicolo v ON c.veicolo_id = v.id WHERE v.driver_id = $1`;
    const params = [driver_id];
    if (status === 'today') query += ` AND c.start_datetime::date = CURRENT_DATE`;
    else if (status) { query += ` AND c."stato" = $2`; params.push(status); }
    const res = await client.query(query, params);
    return res.rows.map(c => ({ ...c, durataMinuti: parseDurataMinuti(c.durata) }));
  } finally { client.release(); }
}

/* ===================== 2️⃣ ACCETTA CORSA ===================== */
export async function accettaCorsa(corsa_id) {
  const client = await pool.connect();
  try {
    const res = await client.query(`UPDATE public.corse SET "stato" = 'accettata' WHERE id = $1 RETURNING *`, [corsa_id]);
    const c = res.rows[0];
    if (c) { upsertCorsa(c); CacheManager.corsa.update(c); }
    return c ? c : null;
  } finally { client.release(); }
}

/* ===================== 3️⃣ START / END CORSA ===================== */
export async function toggleCorsa(corsa_id, action) {
  if (!['start', 'end'].includes(action)) throw new Error('Azione non valida');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newStato = action === 'start' ? 'in_corso' : 'completata';
    
    const corsaRes = await client.query(
      `UPDATE public.corse SET "stato" = $1 WHERE id = $2 RETURNING *`,
      [newStato, corsa_id]
    );

    if (!corsaRes.rows.length) throw new Error('Corsa non trovata');
    const corsa = corsaRes.rows[0];
    CacheManager.corsa.update(corsa);

    if (action === 'end') {
      removeCorsa(corsa_id);

      // Recupero info per finalizzazione pagamenti
      const prenRes = await client.query(
        `SELECT p.id AS pagamento_id, p.stripe_payment_intent, p.prenotazione_id, 
                pr.posti_richiesti
         FROM public.pagamenti p 
         JOIN public.prenotazioni pr ON p.prenotazione_id = pr.id
         WHERE p.corsa_id = $1 AND p.stato = 'autorizzazione'`,
        [corsa_id]
      );

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) continue;

        // Calcolo importo finale tramite la funzione unificata di pricing
        // Passiamo lo stato 'prenotabile' per riutilizzare la logica di calcolo equo esistente nel pricing.util
        let importoFinale = 0;
        if (corsa.tipo_corsa === 'privata') {
            importoFinale = await calcolaPrezzo(corsa, pren.posti_richiesti, 'pubblicato');
        } else {
            importoFinale = await calcolaPrezzo(corsa, pren.posti_richiesti, 'prenotabile');
        }
        
        try {
          const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
          if (pi.status === 'requires_capture') {
            const amountToCapture = Math.min(Math.round(importoFinale * 100), pi.amount);
            await stripe.paymentIntents.capture(pren.stripe_payment_intent, { amount_to_capture: amountToCapture });
            await client.query(`UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, [amountToCapture / 100, pren.pagamento_id]);
          }
        } catch (err) {
          console.error(`Errore pagamento ${pren.pagamento_id}:`, err);
          await client.query(`UPDATE public.pagamenti SET stato = 'fallito' WHERE id = $1`, [pren.pagamento_id]);
        }
      }
    } else {
      upsertCorsa(corsa);
    }

    await client.query('COMMIT');
    return { id: corsa.id, stato: newStato };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}