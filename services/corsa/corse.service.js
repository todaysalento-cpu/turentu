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
    // Utilizziamo la subquery per i posti reali e il JOIN per i dati del veicolo
    let query = `
      SELECT c.*, v.driver_id, v.modello AS veicolo,
             ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon,
             ST_Y(c.destinazione::geometry) AS destinazione_lat, ST_X(c.destinazione::geometry) AS destinazione_lon,
             (SELECT COALESCE(SUM(p.posti_richiesti), 0) 
              FROM public.prenotazioni p 
              WHERE p.corsa_id = c.id) AS posti_prenotati_reali
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

    if (action === 'end') {
      // Calcolo dinamico: ottieni il totale posti occupati REALI
      const postiOccupatiRes = await client.query(
        `SELECT COALESCE(SUM(posti_richiesti), 0) as totale FROM public.prenotazioni WHERE corsa_id = $1`,
        [corsa_id]
      );
      const totalePostiOccupati = Number(postiOccupatiRes.rows[0].totale);

      // Arricchisci per il pricing
      const corsaPerPricing = { ...corsa, posti_prenotati: totalePostiOccupati };

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

        const importoFinale = corsa.tipo_corsa === 'privata' 
          ? Number(pren.importo) 
          : await calcolaPrezzo(corsaPerPricing, postiRichiesti, 'prenotabile');
        
        try {
          const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
          if (pi.status === 'requires_capture') {
            await stripe.paymentIntents.capture(pren.stripe_payment_intent, { 
              amount_to_capture: Math.round(importoFinale * 100) 
            });
            await client.query(`UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, [importoFinale, pren.pagamento_id]);
          }
        } catch (err) {
          console.error(`Errore pagamento ${pren.pagamento_id}:`, err);
          await client.query(`UPDATE public.pagamenti SET stato = 'fallito' WHERE id = $1`, [pren.pagamento_id]);
        }
      }
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