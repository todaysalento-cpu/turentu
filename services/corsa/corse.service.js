import { pool } from '../../db/db.js';
import Stripe from 'stripe';
import { getTariffe, calcolaQuotaEqua } from '../../utils/pricing.util.js'; // Importiamo le nuove funzioni
import { CacheManager } from '../../utils/cacheManager.js';
import { upsertCorsa, removeCorsa } from '../search/search.cache.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ... (funzioni parseDurataMinuti e formatDurata invariate) ... */

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

      // 1. Recupero dati per il calcolo equo
      const postiOccupatiRes = await client.query(
        `SELECT COALESCE(MAX(occ), 0) as totale FROM (SELECT SUM(posti_richiesti) as occ FROM public.prenotazioni WHERE corsa_id = $1 GROUP BY start_index_polyline) as sub`,
        [corsa_id]
      );
      const totalePostiOccupati = Number(postiOccupatiRes.rows[0].totale);
      
      const tariffe = await getTariffe(corsa.veicolo_id, 'standard');
      const costoTotaleCorsa = Number(corsa.distanza) * tariffe.prezzoKm;

      const prenRes = await client.query(
        `SELECT p.id AS pagamento_id, p.stripe_payment_intent, p.prenotazione_id, p.importo
         FROM public.pagamenti p
         WHERE p.corsa_id = $1 AND p.stato = 'autorizzazione'`,
        [corsa_id]
      );

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) continue;

        const postiRes = await client.query(
            'SELECT posti_richiesti FROM public.prenotazioni WHERE id = $1',
            [pren.prenotazione_id]
        );
        const postiRichiesti = postiRes.rows[0]?.posti_richiesti || 1;

        // 2. Calcolo importo finale equo
        const importoCalcolato = corsa.tipo_corsa === 'privata' 
          ? Number(pren.importo) 
          : calcolaQuotaEqua(costoTotaleCorsa, postiRichiesti, totalePostiOccupati);
        
        try {
          const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
          
          if (pi.status === 'requires_capture') {
            // Check di sicurezza: non catturare mai più del pre-autorizzato
            const amountToCapture = Math.min(
                Math.round(importoCalcolato * 100), 
                pi.amount // importo originale della pre-autorizzazione
            );

            await stripe.paymentIntents.capture(pren.stripe_payment_intent, { 
              amount_to_capture: amountToCapture 
            });
            
            await client.query(
                `UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, 
                [amountToCapture / 100, pren.pagamento_id]
            );
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