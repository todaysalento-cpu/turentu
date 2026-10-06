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
      SELECT 
        c.*, 
        v.driver_id, 
        v.modello AS veicolo,
        COALESCE(NULLIF(c.origine_address, 'N/D'), NULLIF(c.origine_address, ''), 'Non specificato') AS origine_address,
        COALESCE(NULLIF(c.destinazione_address, 'N/D'), NULLIF(c.destinazione_address, ''), 'Non specificato') AS destinazione_address,
        COALESCE(SUM(p.posti_richiesti), 0) AS posti_prenotati,
        COALESCE(
          json_agg(
            json_build_object(
              'id', p.id,
              'cliente_id', p.cliente_id,
              'posti_richiesti', p.posti_richiesti,
              'start_offset', p.start_offset,
              'end_offset', p.end_offset,
              'km_utente', p.km_utente,
              'lat_salita', p.lat_salita,
              'lon_salita', p.lon_salita,
              'lat_discesa', p.lat_discesa,
              'lon_discesa', p.lon_discesa,
              'start_index_polyline', p.start_index_polyline,
              'end_index_polyline', p.end_index_polyline
            )
          ) FILTER (WHERE p.id IS NOT NULL), '[]'
        ) AS prenotazioni
      FROM public.corse c 
      JOIN public.veicolo v ON c.veicolo_id = v.id 
      LEFT JOIN public.prenotazioni p ON p.corsa_id = c.id
      WHERE v.driver_id = $1
    `;
    const params = [driver_id];
    
    if (status === 'today') {
      query += ` AND c.start_datetime::date = CURRENT_DATE`;
    } else if (status && status !== 'tutte') {
      query += ` AND c."stato" = $2`;
      params.push(status);
    }
    
    query += ` GROUP BY c.id, v.id, v.driver_id, v.modello ORDER BY c.start_datetime DESC`;
    
    const res = await client.query(query, params);
    
    return res.rows.map(c => ({ 
      ...c, 
      durataMinuti: parseDurataMinuti(c.durata),
      posti_prenotati: Number(c.posti_prenotati),
      prenotazioni: Array.isArray(c.prenotazioni) ? c.prenotazioni : []
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
      console.log(`\n🚀 [CAPTURE FLOW START] Chiusura corsa ID: ${corsa_id} in corso...`);

      // 1. Recupero dei pagamenti e delle informazioni di tratta per ogni passeggero della corsa
      const prenRes = await client.query(
        `SELECT 
          p.id AS pagamento_id, 
          p.stripe_payment_intent, 
          p.prenotazione_id, 
          pr.posti_richiesti, 
          pr.cliente_id,
          pr.start_offset,
          pr.end_offset,
          pr.km_utente
         FROM public.pagamenti p 
         JOIN public.prenotazioni pr ON p.prenotazione_id = pr.id
         WHERE p.corsa_id = $1 AND p.stato = 'autorizzazione'`,
        [corsa_id]
      );

      console.log(`📋 [CAPTURE FLOW] Trovate ${prenRes.rows.length} autorizzazioni di pagamento da elaborare.`);

      // 2. Recupero di tutte le prenotazioni per ricostruire l'array delle percentuali dei passeggeri attivi
      const tuttePrenotazioniRes = await client.query(
        `SELECT id, posti_richiesti, km_utente, start_offset, end_offset 
         FROM public.prenotazioni 
         WHERE corsa_id = $1`,
        [corsa_id]
      );

      const kmTotaliCorsaOriginale = Number(corsa.km_totali_percorso) || Number(corsa.km) || Number(corsa.distanza) || Number(corsa.chilometri) || 10;
      console.log(`📏 [CAPTURE DEBUG] Km totali corsa originale stimati/letti: ${kmTotaliCorsaOriginale}`);

      // Ricostruzione pulita e sicura dell'array delle percentuali dei passeggeri esistenti (ponderate anche per i posti)
      const percentualiEsistenti = tuttePrenotazioniRes.rows.map((p, idx) => {
        const pStart = Number(p.start_offset);
        const pEnd = Number(p.end_offset);
        const postiPaz = Number(p.posti_richiesti) || 1;
        
        let kmUtentePaz = Number(p.km_utente);
        console.log(`  👉 [PREN MAP #${idx+1}] ID Prenotazione: ${p.id} | km_utente nel DB: ${p.km_utente} | start_offset: ${p.start_offset} | end_offset: ${p.end_offset} | Posti: ${postiPaz}`);

        if (!kmUtentePaz || isNaN(kmUtentePaz) || kmUtentePaz <= 0) {
          if (!isNaN(pStart) && !isNaN(pEnd)) {
            let diffMetri = Math.abs(pEnd - pStart);
            if (diffMetri > 1000000) diffMetri = diffMetri / 1000;
            kmUtentePaz = diffMetri / 1000;
            console.log(`     ⚠️ [FALLBACK OFFSET] km_utente calcolato da offset in metri: ${diffMetri}m -> ${kmUtentePaz}km`);
          } else {
            kmUtentePaz = kmTotaliCorsaOriginale;
            console.log(`     ⚠️ [FALLBACK TOTALI] Nessun offset valido, impostato a km totali corsa: ${kmUtentePaz}km`);
          }
        }
        
        let percPaz = (kmUtentePaz / kmTotaliCorsaOriginale) * postiPaz;
        const finalPerc = Math.min(postiPaz, Math.max(0.001, percPaz));
        console.log(`     ✅ [PERCENTUALE CALCOLATA] kmUtentePaz: ${kmUtentePaz} | percPaz ponderata: ${finalPerc}`);
        return finalPerc;
      });

      console.log(`📊 [CAPTURE FLOW] Array percentuali passeggeri esistenti ricostruito con successo:`, percentualiEsistenti);

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) {
          console.warn(`⚠️ [CAPTURE SKIP] Pagamento ID ${pren.pagamento_id} saltato: stripe_payment_intent mancante o vuoto.`);
          continue;
        }

        try {
          const tipoPricing = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(corsa.tipo_corsa)
            ? corsa.tipo_corsa
            : 'standard';

          // Determinazione dei km specifici della tratta del singolo passeggero
          let kmUtente = Number(pren.km_utente);
          if (!kmUtente || isNaN(kmUtente) || kmUtente <= 0) {
            if (pren.start_offset != null && pren.end_offset != null) {
              let diffMetri = Math.abs(Number(pren.end_offset) - Number(pren.start_offset));
              if (diffMetri > 1000000) diffMetri = diffMetri / 1000;
              kmUtente = diffMetri / 1000;
            } else {
              kmUtente = kmTotaliCorsaOriginale;
            }
          }
          kmUtente = Math.min(kmUtente, kmTotaliCorsaOriginale);
          kmUtente = Math.max(0.1, kmUtente);

          console.log(`\n--------------------------------------------------`);
          console.log(`🔍 [CALCOLO PREZZO PASSAGGERO] Pagamento ID: ${pren.pagamento_id} | Prenotazione ID: ${pren.prenotazione_id}`);
          console.log(`🚗 Corsa ID: ${corsa.id} | Posti: ${pren.posti_richiesti} | Tipo: ${tipoPricing} | Km Tratta Utente Validati: ${kmUtente}`);
          
          // Arricchimento dell'oggetto corsa con i dati condivisi necessari al pricing
          const corsaPerPricing = {
            ...corsa,
            percentuali_passeggeri_esistenti: percentualiEsistenti,
            km_totali_percorso: kmTotaliCorsaOriginale
          };

          const prezzoRisolto = await calcolaPrezzo(
            corsaPerPricing,
            pren.posti_richiesti,
            tipoPricing,
            kmUtente,
            kmTotaliCorsaOriginale,
            tuttePrenotazioniRes.rows.length,
            corsa.classe || 'STANDARD',
            corsa.km_avvicinamento || 0,
            corsa.km_riposizionamento || 0,
            false // 👈 SPECIFICHIAMO CHE NON È UN NUOVO UTENTE, MA LA CATTURA DI FINE CORSA
          );
          
          console.log(`🔍 [PREZZO RISOLTO] Valore grezzo restituito dal pricing:`, JSON.stringify(prezzoRisolto));
          
          let rawPrezzo = typeof prezzoRisolto === 'object' && prezzoRisolto !== null 
            ? (prezzoRisolto.prezzo ?? prezzoRisolto.importo ?? 0) 
            : prezzoRisolto;
          
          let importoFinale = (!isNaN(Number(rawPrezzo)) && Number(rawPrezzo) > 0) ? Number(rawPrezzo) : 0;
          console.log(`💰 [IMPORTO FINALE] Importo calcolato validato: €${importoFinale}`);
          
          if (pren.stripe_payment_intent.startsWith('wallet_')) {
            console.log(`👛 [WALLET CAPTURE] Rilevato pagamento via wallet. Aggiornamento diretto a 'pagato' per €${importoFinale}`);
            
            await client.query(
              `UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, 
              [importoFinale, pren.pagamento_id]
            );
            console.log(`✅ [WALLET SUCCESS] Pagamento ${pren.pagamento_id} aggiornato con successo.`);
          } else {
            console.log(`💳 [STRIPE FETCH] Recupero PaymentIntent remoto: ${pren.stripe_payment_intent}`);
            const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
            console.log(`💳 [STRIPE STATUS] PI ID: ${pi.id} | Stato PI: ${pi.status} | Importo Originario PI autorizzato: ${pi.amount} centesimi (€${pi.amount / 100})`);
            
            if (importoFinale <= 0 && pi.amount > 0) {
              importoFinale = pi.amount / 100;
              console.log(`⚠ [STRIPE FALLBACK] Importo calcolato <= 0. Usato importo originario del PaymentIntent: €${importoFinale}`);
            }

            const amountInCents = Math.round(importoFinale * 100);
            
            // 🛡️ SICUREZZA STRIPE: non puoi catturare più di quanto autorizzato originariamente
            const finalAmountToCapture = Math.min(amountInCents, pi.amount);
            console.log(`🔢 [STRIPE CAPTURE PREP] Importo calcolato in centesimi: ${amountInCents} | Importo massimo autorizzato: ${pi.amount} | Importo finale effettivo da catturare: ${finalAmountToCapture} centesimi`);

            if (pi.status === 'requires_capture' && finalAmountToCapture >= 1) {
              console.log(`🚀 [STRIPE CAPTURE EXECUTE] Tentativo di cattura Stripe per ${finalAmountToCapture} centesimi...`);
              await stripe.paymentIntents.capture(pren.stripe_payment_intent, { 
                amount_to_capture: finalAmountToCapture 
              });
              
              const importoEffettivoEuro = finalAmountToCapture / 100;
              await client.query(
                `UPDATE public.pagamenti SET stato = 'pagato', importo = $1 WHERE id = $2`, 
                [importoEffettivoEuro, pren.pagamento_id]
              );
              console.log(`✅ [STRIPE CAPTURE SUCCESS] Pagamento ${pren.pagamento_id} catturato con successo e DB aggiornato a 'pagato'.`);
            } else {
              console.warn(`⚠️ [STRIPE CAPTURE WARNING] Impossibile catturare il pagamento ${pren.pagamento_id}. Motivo -> Stato PI: '${pi.status}' (richiesto 'requires_capture'), Importo in centesimi: ${finalAmountToCapture} (richiesto >= 1).`);
            }
          }
        } catch (err) {
          console.error(`❌ [CAPTURE ERROR] Errore critico durante l'elaborazione del pagamento ${pren.pagamento_id}:`, err);
          await client.query(`UPDATE public.pagamenti SET stato = 'pendente' WHERE id = $1`, [pren.pagamento_id]);
          console.log(`🔄 [DB ROLLBACK STATE] Pagamento ${pren.pagamento_id} impostato sullo stato 'pendente'.`);
        }
      }
      console.log(`🏁 [CAPTURE FLOW END] Elaborazione pagamenti di fine corsa completata.\n--------------------------------------------------`);
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