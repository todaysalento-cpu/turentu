import { pool } from '../../db/db.js';
import Stripe from 'stripe';
import { getTariffe, calcolaPrezzo } from '../../utils/pricing.util.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { removeCorsa } from '../search/search.cache.js';

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
export async function getCorseByAutista(driver_id, status = 'tutte') {
  if (!driver_id) throw new Error("ID autista mancante");
  
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');
    
    let query = `
      SELECT c.*, v.driver_id, v.modello AS veicolo 
      FROM public.corse c 
      JOIN public.veicolo v ON c.veicolo_id = v.id 
      WHERE v.driver_id = $1
    `;
    const params = [driver_id];
    
    if (status === 'today') {
      query += ` AND c.start_datetime::date = CURRENT_DATE`;
    } else if (status && status !== 'tutte') {
      query += ` AND c."stato" = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY c.start_datetime DESC`;
    
    const res = await client.query(query, params);
    
    return res.rows.map(c => ({ 
      ...c, 
      durataMinuti: parseDurataMinuti(c.durata) 
    }));
  } finally { 
    client.release(); 
  }
}

/* ===================== 2️⃣ ACCETTA CORSA ===================== */
export async function accettaCorsa(corsa_id) {
  if (!corsa_id) return null;
  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE public.corse SET "stato" = 'accettata' WHERE id = $1 RETURNING *`, 
      [corsa_id]
    );
    
    const c = res.rows[0];
    if (c) { 
        removeCorsa(corsa_id); 
        CacheManager.corsa.update(c); 
    }
    return c || null;
  } finally { 
    client.release(); 
  }
}

/* ===================== 3️⃣ START / END CORSA ===================== */
export async function toggleCorsa(corsa_id, action) {
  if (!['start', 'end'].includes(action)) throw new Error('Azione non valida');
  if (!corsa_id) throw new Error('ID corsa mancante');

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
    await removeCorsa(corsa_id);

    if (action === 'end') {
      const prenRes = await client.query(
        `SELECT p.id AS pagamento_id, p.stripe_payment_intent, p.prenotazione_id, pr.posti_richiesti, pr.cliente_id
         FROM public.pagamenti p 
         JOIN public.prenotazioni pr ON p.prenotazione_id = pr.id
         WHERE p.corsa_id = $1 AND p.stato = 'autorizzazione'`,
        [corsa_id]
      );

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) continue;

        try {
          const pricingType = corsa.tipo_corsa === 'privata' ? 'pubblicato' : 'prenotabile';
          
          console.log(`🔍 [CALCOLO PREZZO] Corsa ID: ${corsa.id}, Posti: ${pren.posti_richiesti}, Tipo: ${pricingType}`);
          const prezzoRisolto = await calcolaPrezzo(corsa, pren.posti_richiesti, pricingType);
          console.log(`🔍 [PREZZO RISOLTO] Valore grezzo:`, JSON.stringify(prezzoRisolto));
          
          let rawPrezzo = typeof prezzoRisolto === 'object' && prezzoRisolto !== null 
            ? (prezzoRisolto.prezzo ?? prezzoRisolto.importo ?? 0) 
            : prezzoRisolto;
          
          let importoFinale = !isNaN(Number(rawPrezzo)) ? Number(rawPrezzo) : 0;
          console.log(`💰 [IMPORTO FINALE] Calcolato: €${importoFinale}`);
          
          // Controlla se il pagamento è stato fatto tramite Wallet
          if (pren.stripe_payment_intent.startsWith('wallet_')) {
            console.log(`👛 [WALLET] Rilevato pagamento via wallet per la prenotazione ${pren.prenotazione_id}. Importo finale: €${importoFinale}`);
            
            await client.query(
              `UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, 
              [importoFinale, pren.pagamento_id]
            );
          } else {
            // Gestione standard Stripe (PaymentIntent)
            const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
            
            // Fallback se il calcolo restituisce 0 o un valore non valido, usa l'importo originario del PI
            if (importoFinale <= 0 && pi.amount > 0) {
              importoFinale = pi.amount / 100;
              console.log(`⚠️ [FALLBACK STRIPE] Usato importo originario del PI: €${importoFinale}`);
            }

            const amountInCents = Math.round(importoFinale * 100);

            if (pi.status === 'requires_capture' && amountInCents >= 1) {
              await stripe.paymentIntents.capture(pren.stripe_payment_intent, { 
                amount_to_capture: amountInCents 
              });
              await client.query(
                `UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, 
                [importoFinale, pren.pagamento_id]
              );
              console.log(`✅ [STRIPE CAPTURE] Pagamento ${pren.pagamento_id} catturato con successo per ${amountInCents} centesimi.`);
            } else {
              console.warn(`⚠️ Impossibile catturare il pagamento ${pren.pagamento_id}: importo (${amountInCents}) o stato PI non valido (${pi.status}).`);
            }
          }
        } catch (err) {
          console.error(`❌ Errore pagamento ${pren.pagamento_id}:`, err);
          await client.query(`UPDATE public.pagamenti SET stato = 'pendente' WHERE id = $1`, [pren.pagamento_id]);
        }
      }
    }

    await client.query('COMMIT');
    return { ...corsa, stato: newStato };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}