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
      `UPDATE public.corse
       SET "stato" = 'accettata'
       WHERE id = $1 AND stato = 'prenotabile'
       RETURNING *`,
      [corsa_id]
    );

    const c = res.rows[0];
    if (c) {
        try {
          await removeCorsa(corsa_id);
          CacheManager.corsa.update(c);
        } catch (cacheErr) {
          console.error('[CORSA CACHE] Accettazione persistita, cache da riallineare:', cacheErr);
        }
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

    // Transizioni consentite: prenotabile/accettata -> in_corso -> completata.
    // L'UPDATE condizionale impedisce doppie chiusure anche con richieste concorrenti.
    const statiAmmessi = action === 'start'
      ? ['prenotabile', 'accettata']
      : ['in_corso'];

    const nuovoStato = action === 'start'
      ? 'in_corso'
      : 'completata';

    const corsaRes = await client.query(
      `UPDATE public.corse
       SET stato = $1
       WHERE id = $2
         AND stato = ANY($3::varchar[])
       RETURNING *`,
      [nuovoStato, corsa_id, statiAmmessi]
    );

    if (!corsaRes.rows.length) {
      const verifica = await client.query(
        `SELECT id, stato
         FROM public.corse
         WHERE id = $1`,
        [corsa_id]
      );

      if (!verifica.rows.length) {
        throw new Error('Corsa non trovata');
      }

      throw new Error(
        `Transizione non consentita: corsa ${corsa_id} ` +
        `in stato '${verifica.rows[0].stato}', azione '${action}'`
      );
    }

    const corsa = corsaRes.rows[0];

    // La cache viene aggiornata solo dopo il COMMIT.
    if (action === 'end') {
      console.log(`\n🚀 [CAPTURE FLOW START] Chiusura corsa ID: ${corsa_id} in corso...`);

      // 1. Recupero dei pagamenti e delle informazioni di tratta per ogni passeggero della corsa
      const isModelloA = String(corsa.tipo_corsa ?? '').trim().toLowerCase() === 'condivisa'
        && corsa.prezzo_fisso != null;
      const prenRes = await client.query(
        `SELECT
          p.id AS pagamento_id,
          p.stripe_payment_intent,
          p.prenotazione_id,
          p.importo AS importo_db,
          p.stato AS stato_pagamento,
          pr.posti_richiesti,
          pr.cliente_id,
          pr.start_offset,
          pr.end_offset,
          pr.km_utente
         FROM public.pagamenti p
         JOIN public.prenotazioni pr ON p.prenotazione_id = pr.id
         WHERE p.corsa_id = $1 AND (p.stato = 'autorizzazione' OR ($2::boolean AND p.stato = 'pagato'))`,
        [corsa_id, isModelloA]
      );

      console.log(`📋 [CAPTURE FLOW] Trovate ${prenRes.rows.length} autorizzazioni di pagamento da elaborare.`);

      // MODELLO A: verifica completa PRIMA di qualsiasi cattura esterna.
      // In caso di scopertura, non chiudere la corsa e non catturare importi parziali.
      const quoteModelloA = new Map();
      if (isModelloA) {
        const { rows: tutteQuote } = await client.query(`
          SELECT id, prezzo_totale FROM public.prenotazioni
          WHERE corsa_id = $1 ORDER BY id FOR UPDATE
        `, [corsa_id]);
        if (!tutteQuote.length || !Number.isFinite(Number(corsa.prezzo_fisso)) || Number(corsa.prezzo_fisso) <= 0) {
          throw new Error('Modello A: snapshot commerciale o prenotazioni non validi');
        }
        let somma = 0;
        for (const pr of tutteQuote) {
          if (pr.prezzo_totale == null) throw new Error(`Modello A: quota assente per prenotazione ${pr.id}`);
          const cent = Math.round(Number(pr.prezzo_totale) * 100);
          if (!Number.isSafeInteger(cent) || cent <= 0) throw new Error(`Modello A: quota non valida per prenotazione ${pr.id}`);
          quoteModelloA.set(Number(pr.id), cent);
          somma += cent;
        }
        if (somma !== Math.round(Number(corsa.prezzo_fisso) * 100)) {
          throw new Error(`Modello A: ripartizione non quadrata (${somma} cent)`);
        }
        const { rows: tuttiPagamenti } = await client.query(`
          SELECT p.id, p.prenotazione_id, p.stato, p.stripe_payment_intent
          FROM public.pagamenti p WHERE p.corsa_id = $1 FOR UPDATE
        `, [corsa_id]);
        for (const [prenId, quota] of quoteModelloA) {
          const pagamenti = tuttiPagamenti.filter(p => Number(p.prenotazione_id) === prenId);
          if (pagamenti.length !== 1 || !['autorizzazione', 'pagato'].includes(pagamenti[0].stato)) {
            throw new Error(`Modello A: pagamento unico valido mancante per prenotazione ${prenId}`);
          }
          const pagamento = pagamenti[0];
          if (!pagamento.stripe_payment_intent || pagamento.stripe_payment_intent.startsWith('wallet_')) {
            throw new Error(`Modello A: Stripe richiesto per prenotazione ${prenId}`);
          }
          const pi = await stripe.paymentIntents.retrieve(pagamento.stripe_payment_intent);
          if (pi.status === 'succeeded') {
            const incassato = Number(pi.amount_received);
            if (!Number.isSafeInteger(incassato) || incassato !== quota) {
              throw new Error(`Modello A: importo gia incassato non coerente per prenotazione ${prenId} (atteso ${quota}, incassato ${incassato})`);
            }
          } else if (pi.status === 'requires_capture') {
            if (pagamento.stato === 'pagato') {
              throw new Error(`Modello A: pagamento DB pagato ma Stripe non incassato per prenotazione ${prenId}`);
            }
            const catturabile = Number(pi.amount_capturable);
            if (pagamento.stato !== 'autorizzazione' || !Number.isSafeInteger(catturabile) || catturabile < quota) {
              throw new Error(`Modello A: autorizzazione insufficiente o scaduta per prenotazione ${prenId}`);
            }
          } else {
            throw new Error(`Modello A: stato Stripe non catturabile per prenotazione ${prenId}: ${pi.status}`);
          }
        }
        if (prenRes.rows.length !== quoteModelloA.size) {
          throw new Error('Modello A: numero di autorizzazioni diverso dalle prenotazioni');
        }
      }


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

      // Occupazione definitiva: posti delle prenotazioni, non numero di righe.
      // NOTA: lo schema prenotazioni non ha uno stato; verificare a livello applicativo
      // che le prenotazioni annullate siano rimosse o escluse prima della chiusura.
      const totalePasseggeriDefinitivo = tuttePrenotazioniRes.rows.reduce(
        (somma, p) => somma + Number(p.posti_richiesti || 0),
        0
      );
      if (!Number.isSafeInteger(totalePasseggeriDefinitivo) || totalePasseggeriDefinitivo < 0) {
        throw new Error(`Totale passeggeri non valido per corsa ${corsa_id}`);
      }

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) {
          console.warn(`⚠️ [CAPTURE SKIP] Pagamento ID ${pren.pagamento_id} saltato: stripe_payment_intent mancante o vuoto.`);
          continue;
        }

        let savepointAttivo = false;
        try {
          // Evita che un errore SQL relativo a un singolo pagamento
          // lasci abortita l'intera transazione della corsa.
          await client.query('SAVEPOINT payment_capture_item');
          savepointAttivo = true;

          const tipoCorsaNormalizzato = String(corsa.tipo_corsa ?? '')
            .trim()
            .toLowerCase();

          const isPopbus = [
            'popbus',
            'pop-bus',
            'pop_bus',
            'riempimento',
          ].includes(tipoCorsaNormalizzato);

          const tipoPricing = isPopbus ? null : tipoCorsaNormalizzato;

          if (!isPopbus && !['privata', 'condivisa'].includes(tipoPricing)) {
            throw new Error(
              `Tipo corsa non riconosciuto: '${corsa.tipo_corsa}' (ID ${corsa.id})`
            );
          }

          // POPBUS/riempimento: non ricalcolare il prezzo a fine corsa.
          // Privata/condivisa: mantenere il ricalcolo già previsto dal pricing.
          let importoFinale = null;

          if (isModelloA) {
            importoFinale = quoteModelloA.get(Number(pren.prenotazione_id)) / 100;
          } else if (!isPopbus) {
            // Determinazione dei km specifici della tratta del singolo passeggero.
            let kmUtente = Number(pren.km_utente);
            if (!kmUtente || !Number.isFinite(kmUtente) || kmUtente <= 0) {
              if (pren.start_offset != null && pren.end_offset != null) {
                let diffMetri = Math.abs(
                  Number(pren.end_offset) - Number(pren.start_offset)
                );
                if (diffMetri > 1000000) diffMetri /= 1000;
                kmUtente = diffMetri / 1000;
              } else {
                kmUtente = kmTotaliCorsaOriginale;
              }
            }

            kmUtente = Math.min(kmUtente, kmTotaliCorsaOriginale);
            kmUtente = Math.max(0.1, kmUtente);

            console.log(`\\n--------------------------------------------------`);
            console.log(
              `🔍 [CALCOLO PREZZO PASSAGGERO] Pagamento ID: ${pren.pagamento_id} | ` +
              `Prenotazione ID: ${pren.prenotazione_id}`
            );
            console.log(
              `🚗 Corsa ID: ${corsa.id} | Posti: ${pren.posti_richiesti} | ` +
              `Tipo: ${tipoPricing} | Km Tratta Utente Validati: ${kmUtente}`
            );

            const corsaPerPricing = {
              ...corsa,
              percentuali_passeggeri_esistenti: percentualiEsistenti,
              km_totali_percorso: kmTotaliCorsaOriginale,
            };

            const postiPrenotazione = Number(pren.posti_richiesti);
            if (!Number.isSafeInteger(postiPrenotazione) || postiPrenotazione <= 0 ||
                (tipoPricing === 'condivisa' && postiPrenotazione > totalePasseggeriDefinitivo)) {
              throw new Error(`Posti non validi per prenotazione ${pren.prenotazione_id}`);
            }
            const altriPasseggeri = tipoPricing === 'condivisa'
              ? totalePasseggeriDefinitivo - postiPrenotazione
              : 0;

            const prezzoRisolto = await calcolaPrezzo(
              corsaPerPricing,
              pren.posti_richiesti,
              tipoPricing,
              kmUtente,
              kmTotaliCorsaOriginale,
              altriPasseggeri,
              corsa.classe || 'STANDARD',
              corsa.km_avvicinamento || 0,
              corsa.km_riposizionamento || 0,
              false
            );

            console.log(
              `🔍 [PREZZO RISOLTO] Valore grezzo restituito dal pricing:`,
              JSON.stringify(prezzoRisolto)
            );

            const rawPrezzo =
              typeof prezzoRisolto === 'object' && prezzoRisolto !== null
                ? (prezzoRisolto.prezzo ?? prezzoRisolto.importo ?? 0)
                : prezzoRisolto;

            importoFinale =
              Number.isFinite(Number(rawPrezzo)) && Number(rawPrezzo) > 0
                ? Number(rawPrezzo)
                : 0;

            console.log(`💰 [IMPORTO FINALE] Importo ricalcolato: €${importoFinale}`);
          } else {
            console.log(
              `[POPBUS/RIEMPIMENTO] Pagamento ${pren.pagamento_id}: ` +
              `nessun ricalcolo; verrà catturata l'autorizzazione disponibile su Stripe.`
            );
          }

          if (pren.stripe_payment_intent.startsWith('wallet_')) {
            const importoDaRegistrare = isPopbus
              ? Number(pren.importo_db)
              : importoFinale;

            if (
              !Number.isFinite(importoDaRegistrare) ||
              importoDaRegistrare <= 0
            ) {
              throw new Error(
                `Importo wallet non valido per pagamento ${pren.pagamento_id}`
              );
            }

            await client.query(
              `UPDATE public.pagamenti
               SET stato = 'pagato', importo = $1, updated_at = NOW()
               WHERE id = $2`,
              [importoDaRegistrare, pren.pagamento_id]
            );
            console.log(
              `✅ [WALLET SUCCESS] Pagamento ${pren.pagamento_id} aggiornato a pagato: ` +
              `€${importoDaRegistrare.toFixed(2)}.`
            );
          } else {
            const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);

            console.log(
              `[STRIPE STATUS] Pagamento ${pren.pagamento_id}: ` +
              `PaymentIntent=${pi.id}, status=${pi.status}, ` +
              `amount=${pi.amount}, amount_received=${pi.amount_received ?? 0}`
            );

            // Stripe ha già incassato: riconcilia il DB senza una seconda cattura.
            if (pi.status === 'succeeded') {
              const importoEffettivoEuro = Number(pi.amount_received ?? 0) / 100;

              if (importoEffettivoEuro <= 0) {
                throw new Error(`PaymentIntent ${pi.id} succeeded senza importo incassato positivo`);
              }
              if (isModelloA && Number(pi.amount_received) !== quoteModelloA.get(Number(pren.prenotazione_id))) {
                throw new Error(`Modello A: incasso Stripe non coincide con quota finale per pagamento ${pren.pagamento_id}`);
              }

              await client.query(
                `UPDATE public.pagamenti
                 SET stato = 'pagato', importo = $1, updated_at = NOW()
                 WHERE id = $2`,
                [importoEffettivoEuro, pren.pagamento_id]
              );

              console.log(
                `[STRIPE RECONCILE] Pagamento ${pren.pagamento_id} riconciliato: ` +
                `€${importoEffettivoEuro.toFixed(2)}`
              );

            } else if (pi.status === 'requires_capture') {
              if (isModelloA && pren.stato_pagamento === 'pagato') {
                throw new Error(`Modello A: DB pagato ma Stripe non incassato per pagamento ${pren.pagamento_id}`);
              }
              const importoAutorizzatoCentesimi = Number(pi.amount_capturable ?? 0);

              if (
                !Number.isSafeInteger(importoAutorizzatoCentesimi) ||
                importoAutorizzatoCentesimi < 1
              ) {
                throw new Error(
                  `Importo autorizzato non valido per ${pi.id}: ` +
                  `${importoAutorizzatoCentesimi}`
                );
              }

              let finalAmountToCapture;

              if (isModelloA) {
                finalAmountToCapture = quoteModelloA.get(Number(pren.prenotazione_id));
                if (finalAmountToCapture > importoAutorizzatoCentesimi) {
                  throw new Error(`Modello A: autorizzazione insufficiente per pagamento ${pren.pagamento_id}`);
                }
              } else if (isPopbus) {
                // POPBUS/riempimento: cattura tutta l'autorizzazione disponibile.
                finalAmountToCapture = importoAutorizzatoCentesimi;
              } else {
                if (
                  !Number.isFinite(importoFinale) ||
                  importoFinale <= 0
                ) {
                  throw new Error(
                    `Prezzo finale non valido per il pagamento ${pren.pagamento_id}`
                  );
                }

                // Privata/condivisa: il ricalcolo non può superare l'autorizzazione Stripe.
                const prezzoFinaleCentesimi = Math.round(importoFinale * 100);
                finalAmountToCapture = Math.min(
                  prezzoFinaleCentesimi,
                  importoAutorizzatoCentesimi
                );
                if (prezzoFinaleCentesimi > importoAutorizzatoCentesimi) {
                  console.warn(
                    `[DIFFERENZA DA RICONCILIARE] Pagamento ${pren.pagamento_id}: ` +
                    `prezzo finale=${prezzoFinaleCentesimi} cent, ` +
                    `catturabile=${importoAutorizzatoCentesimi} cent, ` +
                    `differenza=${prezzoFinaleCentesimi - importoAutorizzatoCentesimi} cent.`
                  );
                }
              }

              if (
                !Number.isSafeInteger(finalAmountToCapture) ||
                finalAmountToCapture < 1
              ) {
                throw new Error(
                  `Importo da catturare non valido per ${pi.id}: ${finalAmountToCapture}`
                );
              }

              console.log(
                `[STRIPE CAPTURE PREP] Pagamento ${pren.pagamento_id}: ` +
                `${finalAmountToCapture} centesimi; autorizzati catturabili=${importoAutorizzatoCentesimi}`
              );

              const risultato = await stripe.paymentIntents.capture(
                pi.id,
                { amount_to_capture: finalAmountToCapture },
                {
                  idempotencyKey: `capture-payment-${pren.pagamento_id}-${finalAmountToCapture}`
                }
              );

              if (risultato.status !== 'succeeded') {
                throw new Error(`Cattura non confermata per ${pi.id}: ${risultato.status}`);
              }

              const importoEffettivoEuro = Number(risultato.amount_received ?? 0) / 100;
              if (importoEffettivoEuro <= 0) {
                throw new Error(`Cattura senza importo incassato positivo per ${pi.id}`);
              }
              if (isModelloA && Number(risultato.amount_received) !== finalAmountToCapture) {
                throw new Error(`Modello A: cattura Stripe non coincide con quota finale per pagamento ${pren.pagamento_id}`);
              }

              await client.query(
                `UPDATE public.pagamenti
                 SET stato = 'pagato', importo = $1, updated_at = NOW()
                 WHERE id = $2`,
                [importoEffettivoEuro, pren.pagamento_id]
              );

              console.log(
                `[STRIPE CAPTURE SUCCESS] Pagamento ${pren.pagamento_id}: ` +
                `€${importoEffettivoEuro.toFixed(2)}`
              );

            } else if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
              const statoStripe = pi.status === 'canceled' ? 'annullato' : 'fallito';

              await client.query(
                `UPDATE public.pagamenti
                 SET stato = $1, updated_at = NOW()
                 WHERE id = $2`,
                [statoStripe, pren.pagamento_id]
              );

              console.warn(
                `[STRIPE STATUS SYNC] Pagamento ${pren.pagamento_id} aggiornato a ${statoStripe}.`
              );

            } else {
              // Stati transitori o non riconosciuti: lascia invariato lo stato DB.
              console.warn(
                `[STRIPE RECONCILE PENDING] Pagamento ${pren.pagamento_id}: ` +
                `stato Stripe=${pi.status}; stato DB invariato.`
              );
            }
          }

          await client.query('RELEASE SAVEPOINT payment_capture_item');
          savepointAttivo = false;

        } catch (err) {
          console.error(
            `[CAPTURE ERROR] Pagamento ${pren.pagamento_id}, ` +
            `PaymentIntent ${pren.stripe_payment_intent}:`,
            err.message
          );

          // Ripristina la transazione SQL al punto precedente al singolo pagamento.
          // Non riportare il pagamento a "pendente": Stripe potrebbe aver già incassato.
          if (savepointAttivo) {
            try {
              await client.query('ROLLBACK TO SAVEPOINT payment_capture_item');
              await client.query('RELEASE SAVEPOINT payment_capture_item');
            } catch (rollbackPagamentoErr) {
              console.error(
                `[CAPTURE SAVEPOINT ERROR] Pagamento ${pren.pagamento_id}:`,
                rollbackPagamentoErr.message
              );
              throw rollbackPagamentoErr;
            }
          }
          if (isModelloA) throw err;
        }
      }
      console.log(`🏁 [CAPTURE FLOW END] Elaborazione pagamenti di fine corsa completata.\n--------------------------------------------------`);
    }

    await client.query('COMMIT');
    try {
      await removeCorsa(corsa_id);
      CacheManager.corsa.update(corsa);
    } catch (cacheErr) {
      console.error('[CORSA CACHE] Transizione persistita, cache da riallineare:', cacheErr);
    }
    return { ...corsa, stato: nuovoStato };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}