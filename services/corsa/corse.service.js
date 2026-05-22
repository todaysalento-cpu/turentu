import { pool } from '../../db/db.js';
import Stripe from 'stripe';
import { calcolaPrezzo } from '../../utils/pricing.util.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ===================== HELPERS ===================== */
function parseDurataMinuti(durata) {
  if (!durata) return 0;
  if (typeof durata === 'number') return durata;
  if (typeof durata === 'string') {
    const parts = durata.split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }
  return 0;
}

function formatDurata(minuti) {
  return `${Math.floor(minuti / 60)}h ${minuti % 60}m`;
}

/* ===================== 1️⃣ CORSE PER AUTISTA ===================== */
export async function getCorseByAutista(driver_id, status = '') {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');
    let query = `
      SELECT c.id, c.veicolo_id, v.driver_id, v.modello AS veicolo, c.tipo_corsa, 
             c.start_datetime, c.arrivo_datetime, c.durata, c.distanza,
             ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon,
             ST_Y(c.destinazione::geometry) AS destinazione_lat, ST_X(c.destinazione::geometry) AS destinazione_lon,
             c.origine_address, c.destinazione_address, c."stato", c.prezzo_fisso AS prezzo,
             c.posti_disponibili, c.posti_totali, c.posti_prenotati
      FROM public.corse c
      JOIN public.veicolo v ON c.veicolo_id = v.id
      WHERE v.driver_id = $1`;
    const params = [driver_id];
    if (status === 'today') query += ` AND c.start_datetime::date = CURRENT_DATE`;
    else if (status === 'non_completate') query += ` AND c."stato" != 'completata'`;
    else if (status) { query += ` AND c."stato" = $2`; params.push(status); }
    query += ` ORDER BY c.start_datetime ASC`;
    const res = await client.query(query, params);
    return res.rows.map(c => ({
      ...c,
      durataMinuti: parseDurataMinuti(c.durata),
      durataFormattata: formatDurata(parseDurataMinuti(c.durata)),
      ora: new Date(c.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      data: new Date(c.start_datetime).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' })
    }));
  } finally { client.release(); }
}

/* ===================== 2️⃣ ACCETTA CORSA ===================== */
export async function accettaCorsa(corsa_id) {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');
    const res = await client.query(`UPDATE public.corse SET "stato" = 'accettata' WHERE id = $1 RETURNING *`, [corsa_id]);
    const c = res.rows[0];
    return c ? { ...c, durataMinuti: parseDurataMinuti(c.durata) } : null;
  } finally { client.release(); }
}

/* ===================== 3️⃣ START / END CORSA ===================== */
export async function toggleCorsa(corsa_id, action) {
  console.log(`[DEBUG] >> Inizio toggleCorsa | ID: ${corsa_id} | Azione: ${action}`);

  if (!['start', 'end'].includes(action)) {
    console.error(`[DEBUG] !! Azione non valida: ${action}`);
    throw new Error('Azione non valida');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO public');

    const newStato = action === 'start' ? 'in_corso' : 'completata';
    console.log(`[DEBUG] Transazione: Imposto stato a '${newStato}'`);

    const corsaRes = await client.query(
      `UPDATE public.corse SET "stato" = $1 WHERE id = $2 RETURNING *`,
      [newStato, corsa_id]
    );

    if (!corsaRes.rows.length) throw new Error('Corsa non trovata');
    const corsa = corsaRes.rows[0];

    if (action === 'end') {
      console.log(`[DEBUG] Elaborazione pagamenti per Corsa ${corsa_id}...`);
      const prenRes = await client.query(
        `SELECT p.id AS pagamento_id, p.stripe_payment_intent, p.importo, p.corsa_id, p.stato, COALESCE(pr.posti_prenotati, 1) AS posti_prenotati
         FROM public.pagamenti p
         LEFT JOIN public.prenotazioni pr ON pr.id = p.prenotazione_id
         WHERE (p.corsa_id = $1 OR pr.corsa_id = $1) AND p.stato = 'autorizzazione'`,
        [corsa_id]
      );

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) continue;
        let importoFinale = corsa.tipo_corsa === 'privata' ? Number(pren.importo) : await calcolaPrezzo({ ...corsa, distanza: Number(corsa.distanza) || 0 }, pren.posti_prenotati || 1, 'prenotabile');
        
        try {
          const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
          if (pi.status === 'requires_capture') {
            await stripe.paymentIntents.capture(pren.stripe_payment_intent, { amount_to_capture: Math.round(importoFinale * 100) });
            await client.query(`UPDATE public.pagamenti SET stato = 'pagato', importo = $1, updated_at = NOW() WHERE id = $2`, [importoFinale, pren.pagamento_id]);
            console.log(`[DEBUG] Pagamento ${pren.pagamento_id} catturato.`);
          }
        } catch (err) {
          console.error(`[DEBUG] Errore Stripe:`, err);
          await client.query(`UPDATE public.pagamenti SET stato = 'fallito', updated_at = NOW() WHERE id = $1`, [pren.pagamento_id]);
        }
      }
    }

    await client.query('COMMIT');
    const risultato = {
      id: corsa.id,
      stato: newStato,
      veicolo_id: corsa.veicolo_id,
      tipo_corsa: corsa.tipo_corsa
    };

    console.log(`[DEBUG] << Fine toggleCorsa con successo. Ritorno:`, risultato);
    return risultato;

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[DEBUG] !! Errore CRITICO in toggleCorsa:`, err);
    throw err;
  } finally {
    client.release();
  }
}