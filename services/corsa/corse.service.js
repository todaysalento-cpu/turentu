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
      try {
        await removeCorsa(corsa_id);
      } catch (cacheErr) {
        console.error('[POST-UPDATE REDIS CLEANUP FAILED] corsa=', corsa_id, cacheErr);
      }
    }
    return c || null;
  } finally {
    client.release();
  }
}

/* ===================== 3️⃣ START / END CORSA ===================== */
export async function toggleCorsa(corsa_id, action, utenteId) {
  if (!['start', 'end'].includes(action)) throw new Error('Azione non valida');
  if (!corsa_id) throw new Error('ID corsa mancante');
  if (!Number.isSafeInteger(Number(utenteId)) || Number(utenteId) <= 0) {
    const err = new Error('Utente non autenticato');
    err.status = 401;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newStato = action === 'start' ? 'in_corso' : 'completata';
    const statoRichiesto = action === 'start' ? 'accettata' : 'in_corso';

    // La transizione condizionata protegge anche da richieste concorrenti.
    // La riga resta bloccata fino a COMMIT/ROLLBACK.
    const corsaRes = await client.query(
      `UPDATE public.corse
       SET "stato" = $1
       WHERE id = $2 AND "stato" = $3
       RETURNING *`,
      [newStato, corsa_id, statoRichiesto]
    );

    if (!corsaRes.rows.length) {
      const statoRes = await client.query(
        `SELECT stato FROM public.corse WHERE id = $1`,
        [corsa_id]
      );
      if (!statoRes.rows.length) {
        throw new Error(`Corsa ${corsa_id} non trovata`);
      }
      throw new Error(
        `Transizione non consentita: corsa ${corsa_id} ` +
        `in stato '${statoRes.rows[0].stato}', azione '${action}'`
      );
    }
    const corsa = corsaRes.rows[0];

    // Autorizzazione esecuzione: mai dedurre il conducente da veicolo.driver_id.
    // La verifica e il lock avvengono nella stessa transazione della corsa.
    const assegnazioni = await client.query(`
      SELECT ac.id
      FROM public.assegnazioni_conducenti ac
      JOIN public.veicolo v ON v.id = ac.veicolo_id
      WHERE ac.stato = 'assegnata'
        AND ac.conducente_id = $2
        AND ac.operatore_id = v.driver_id
        AND ac.veicolo_id = $3
        AND (
          ac.corsa_id = $1
          OR EXISTS (
            SELECT 1 FROM public.popbus_attivazioni pa
            WHERE pa.id = ac.attivazione_id
              AND pa.corsa_id = $1
              AND pa.veicolo_id = ac.veicolo_id
              AND pa.autista_id = ac.operatore_id
          )
        )
        AND (
          (ac.modalita = 'titolare' AND ac.conducente_id = ac.operatore_id)
          OR (ac.modalita IN ('manuale','automatica')
              AND ac.conducente_id <> ac.operatore_id
              AND EXISTS (
                SELECT 1 FROM public.conducenti_operatori co
                WHERE co.operatore_id = ac.operatore_id
                  AND co.conducente_id = ac.conducente_id
                  AND co.stato = 'attivo'
              ))
        )
      FOR UPDATE OF ac
    `, [corsa_id, Number(utenteId), corsa.veicolo_id]);

    if (assegnazioni.rows.length !== 1) {
      const err = new Error('Conducente non autorizzato o assegnazione ambigua/assente');
      err.status = 403;
      err.code = 'CONDUCENTE_NON_AUTORIZZATO';
      throw err;
    }
    const assegnazioneId = assegnazioni.rows[0].id;

    if (action === 'end') {
      console.log(`\n🚀 [CAPTURE FLOW START] Chiusura corsa ID: ${corsa_id} in corso...`);

      // Il Modello A è identificato dallo snapshot commerciale persistito.
      // La quota autorevole di ciascun passeggero è prenotazioni.prezzo_totale.
      const prezzoFisso = corsa.prezzo_fisso == null ? null : Number(corsa.prezzo_fisso);
      const prenotazioneOrigineId = corsa.prenotazione_origine_id == null
        ? null : Number(corsa.prenotazione_origine_id);
      const modelloA = Number.isFinite(prezzoFisso) && prezzoFisso > 0 &&
        Number.isSafeInteger(prenotazioneOrigineId) && prenotazioneOrigineId > 0;

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
          pr.km_utente,
          pr.prezzo_totale
         FROM public.pagamenti p
         JOIN public.prenotazioni pr ON p.prenotazione_id = pr.id
         WHERE p.corsa_id = $1 AND p.stato = 'autorizzazione'
         ORDER BY p.id`,
        [corsa_id]
      );

      console.log(
        `📋 [CAPTURE FLOW] Trovate ${prenRes.rows.length} autorizzazioni. ` +
        `Modello A: ${modelloA ? 'SI' : 'NO'}`
      );

      const tuttePrenotazioniRes = await client.query(
        `SELECT id, posti_richiesti, km_utente, start_offset, end_offset
         FROM public.prenotazioni
         WHERE corsa_id = $1`,
        [corsa_id]
      );

      // Guardrail LIVE: una prenotazione deve avere esattamente un pagamento
      // della stessa corsa. Blocca mancanti, duplicati e stati incompatibili.
      // Il controllo precede ogni chiamata di cattura Stripe.
      const coperturaRes = await client.query(
        `SELECT pr.id AS prenotazione_id, pr.prezzo_totale,
                p.id AS pagamento_id, p.stato AS stato_pagamento,
                p.stripe_payment_intent, p.importo AS importo_pagato
         FROM public.prenotazioni pr
         LEFT JOIN public.pagamenti p
           ON p.prenotazione_id = pr.id AND p.corsa_id = pr.corsa_id
         WHERE pr.corsa_id = $1
         ORDER BY pr.id, p.id`,
        [corsa_id]
      );
      if (!coperturaRes.rows.length) {
        throw new Error(`Corsa ${corsa_id}: nessuna prenotazione da contabilizzare`);
      }
      const pagamentiPerPrenotazione = new Set();
      for (const record of coperturaRes.rows) {
        const id = Number(record.prenotazione_id);
        if (record.pagamento_id == null) {
          throw new Error(`Prenotazione ${id}: pagamento mancante`);
        }
        if (pagamentiPerPrenotazione.has(id)) {
          throw new Error(`Prenotazione ${id}: pagamenti duplicati`);
        }
        pagamentiPerPrenotazione.add(id);
        if (!['autorizzazione', 'pagato'].includes(record.stato_pagamento)) {
          throw new Error(`Prenotazione ${id}: stato pagamento non ammesso '${record.stato_pagamento}'`);
        }
        if (!record.stripe_payment_intent) {
          throw new Error(`Prenotazione ${id}: identificativo pagamento mancante`);
        }
        // Un pagamento già contabilizzato non viene mai catturato nuovamente.
        // Per il Modello A, verifica la quota DB e, per Stripe, l'incasso reale.
        if (record.stato_pagamento === 'pagato' && modelloA) {
          const quota = Math.round(Number(record.prezzo_totale) * 100);
          const contabilizzato = Math.round(Number(record.importo_pagato) * 100);
          if (!Number.isSafeInteger(quota) || quota <= 0 || contabilizzato !== quota) {
            throw new Error(`Modello A: importo pagato incongruente per prenotazione ${id}`);
          }
          if (!String(record.stripe_payment_intent).startsWith('wallet_')) {
            const piPagato = await stripe.paymentIntents.retrieve(record.stripe_payment_intent);
            if (piPagato?.status !== 'succeeded' ||
                String(piPagato.currency || 'eur').toLowerCase() !== 'eur' ||
                Number(piPagato.amount_received) !== quota) {
              throw new Error(`Modello A: incasso Stripe non riconciliato per prenotazione ${id}`);
            }
          }
        }
      }
      const pagamentiOrfaniRes = await client.query(
        `SELECT p.id FROM public.pagamenti p
         LEFT JOIN public.prenotazioni pr
           ON pr.id = p.prenotazione_id AND pr.corsa_id = p.corsa_id
         WHERE p.corsa_id = $1 AND pr.id IS NULL LIMIT 1`,
        [corsa_id]
      );
      if (pagamentiOrfaniRes.rows.length) {
        throw new Error(`Corsa ${corsa_id}: pagamento senza prenotazione corrispondente`);
      }
      if (prenRes.rows.length !== coperturaRes.rows.filter(r => r.stato_pagamento === 'autorizzazione').length) {
        throw new Error(`Corsa ${corsa_id}: autorizzazioni incoerenti`);
      }

      // Verifica aritmetica dello snapshot prima di qualsiasi cattura:
      // la somma delle quote deve coincidere con il prezzo fisso, al centesimo.
      if (modelloA) {
        const quoteRes = await client.query(
          `SELECT id, prezzo_totale
           FROM public.prenotazioni
           WHERE corsa_id = $1
           ORDER BY id`,
          [corsa_id]
        );
        const quoteCentesimi = quoteRes.rows.map(row => {
          const quota = Number(row.prezzo_totale);
          if (!Number.isFinite(quota) || quota <= 0) return NaN;
          return Math.round(quota * 100);
        });
        const totaleQuote = quoteCentesimi.reduce((sum, value) => sum + value, 0);
        const prezzoFissoCentesimi = Math.round(prezzoFisso * 100);

        if (!quoteCentesimi.length ||
            quoteCentesimi.some(value => !Number.isSafeInteger(value) || value <= 0) ||
            !Number.isSafeInteger(prezzoFissoCentesimi) ||
            totaleQuote !== prezzoFissoCentesimi) {
          throw new Error(
            `Modello A: ripartizione non quadrata per corsa ${corsa_id} ` +
            `(quote=${totaleQuote}, prezzo_fisso=${prezzoFissoCentesimi} centesimi)`
          );
        }
      }

      const kmTotaliCorsaOriginale =
        Number(corsa.km_totali_percorso) ||
        Number(corsa.km) ||
        Number(corsa.distanza) ||
        Number(corsa.chilometri) ||
        10;

      // Percentuali ricostruite solo per il pricing legacy.
      const percentualiEsistenti = tuttePrenotazioniRes.rows.map((p, idx) => {
        const pStart = Number(p.start_offset);
        const pEnd = Number(p.end_offset);
        const postiPaz = Number(p.posti_richiesti) || 1;
        let kmUtentePaz = Number(p.km_utente);

        if (!kmUtentePaz || !Number.isFinite(kmUtentePaz) || kmUtentePaz <= 0) {
          if (Number.isFinite(pStart) && Number.isFinite(pEnd)) {
            let diffMetri = Math.abs(pEnd - pStart);
            if (diffMetri > 1000000) diffMetri /= 1000;
            kmUtentePaz = diffMetri / 1000;
          } else {
            kmUtentePaz = kmTotaliCorsaOriginale;
          }
        }

        const percPaz = (kmUtentePaz / kmTotaliCorsaOriginale) * postiPaz;
        return Math.min(postiPaz, Math.max(0.001, percPaz));
      });

      const tipoPricing = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(corsa.tipo_corsa)
        ? corsa.tipo_corsa
        : 'standard';

      // FASE 1: preflight completo. Tutti i prezzi e tutti gli stati Stripe
      // vengono verificati prima di effettuare la prima cattura.
      const plans = [];

      for (const pren of prenRes.rows) {
        if (!pren.stripe_payment_intent) {
          throw new Error(
            `Pagamento ${pren.pagamento_id}: PaymentIntent mancante; cattura bloccata`
          );
        }

        let importoFinale;

        if (modelloA) {
          importoFinale = Number(pren.prezzo_totale);
          if (!Number.isFinite(importoFinale) || importoFinale <= 0) {
            throw new Error(
              `Modello A: prezzo_totale non valido per prenotazione ${pren.prenotazione_id}`
            );
          }
        } else {
          // Pricing legacy mantenuto: stessi parametri, algoritmo e fallback.
          let kmUtente = Number(pren.km_utente);
          if (!kmUtente || !Number.isFinite(kmUtente) || kmUtente <= 0) {
            if (pren.start_offset != null && pren.end_offset != null) {
              let diffMetri = Math.abs(Number(pren.end_offset) - Number(pren.start_offset));
              if (diffMetri > 1000000) diffMetri /= 1000;
              kmUtente = diffMetri / 1000;
            } else {
              kmUtente = kmTotaliCorsaOriginale;
            }
          }
          kmUtente = Math.min(kmUtente, kmTotaliCorsaOriginale);
          kmUtente = Math.max(0.1, kmUtente);

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
            false
          );

          const rawPrezzo = typeof prezzoRisolto === 'object' && prezzoRisolto !== null
            ? (prezzoRisolto.prezzo ?? prezzoRisolto.importo ?? 0)
            : prezzoRisolto;

          importoFinale = Number(rawPrezzo);
          if (!Number.isFinite(importoFinale) || importoFinale <= 0) {
            importoFinale = 0;
          }
        }

        if (String(pren.stripe_payment_intent).startsWith('wallet_')) {
          const walletCents = Math.round(importoFinale * 100);
          if (!Number.isSafeInteger(walletCents) || walletCents < 1) {
            throw new Error(`Importo wallet non valido per pagamento ${pren.pagamento_id}`);
          }
          plans.push({
            pren,
            wallet: true,
            amountInCents: walletCents,
            importoFinale: walletCents / 100
          });
          continue;
        }

        const pi = await stripe.paymentIntents.retrieve(pren.stripe_payment_intent);
        if (!pi) {
          throw new Error(`PaymentIntent ${pren.stripe_payment_intent}: risposta Stripe vuota`);
        }
        if (pi.currency && String(pi.currency).toLowerCase() !== 'eur') {
          throw new Error(`PaymentIntent ${pi.id}: valuta diversa da EUR`);
        }

        // Fallback e limite storico restano esclusivamente nel pricing legacy.
        if (!modelloA && importoFinale <= 0 && Number(pi.amount) > 0) {
          importoFinale = Number(pi.amount) / 100;
        }

        const calculatedCents = Math.round(importoFinale * 100);
        if (!Number.isSafeInteger(calculatedCents) || calculatedCents < 1) {
          throw new Error(
            `${modelloA ? 'Modello A: ' : ''}importo non valido per pagamento ${pren.pagamento_id}`
          );
        }

        const amountInCents = modelloA
          ? calculatedCents
          : Math.min(calculatedCents, Number(pi.amount));

        if (!Number.isSafeInteger(amountInCents) || amountInCents < 1) {
          throw new Error(`Importo da catturare non valido per PaymentIntent ${pi.id}`);
        }

        if (pi.status === 'requires_capture') {
          const capturable = Number(pi.amount_capturable);
          if (!Number.isSafeInteger(capturable) || capturable < amountInCents) {
            throw new Error(
              `${modelloA ? 'Modello A: ' : ''}autorizzazione insufficiente ` +
              `per ${pi.id}: richiesti ${amountInCents}, disponibili ${capturable}`
            );
          }
          plans.push({
            pren,
            wallet: false,
            pi,
            amountInCents,
            importoFinale: amountInCents / 100,
            alreadySucceeded: false
          });
        } else if (pi.status === 'succeeded') {
          const received = Number(pi.amount_received);
          if (!Number.isSafeInteger(received) || received !== amountInCents) {
            throw new Error(
              `${modelloA ? 'Modello A: ' : ''}incasso Stripe già effettuato ma errato ` +
              `per ${pi.id}: attesi ${amountInCents}, ricevuti ${received}`
            );
          }
          plans.push({
            pren,
            wallet: false,
            pi,
            amountInCents,
            importoFinale: amountInCents / 100,
            alreadySucceeded: true
          });
        } else {
          throw new Error(
            `PaymentIntent ${pi.id}: stato '${pi.status}' non catturabile; operazione bloccata`
          );
        }
      }

      // FASE 2: dopo il preflight completo, riconcilia o cattura.
      for (const plan of plans) {
        const { pren, amountInCents, importoFinale } = plan;

        if (plan.wallet) {
          await client.query(
            `UPDATE public.pagamenti
             SET stato = 'pagato', importo = $1, updated_at = NOW()
             WHERE id = $2`,
            [importoFinale, pren.pagamento_id]
          );
          continue;
        }

        if (plan.alreadySucceeded) {
          await client.query(
            `UPDATE public.pagamenti
             SET stato = 'pagato', importo = $1, updated_at = NOW()
             WHERE id = $2`,
            [importoFinale, pren.pagamento_id]
          );
          console.log(`[STRIPE RECONCILED] Pagamento ${pren.pagamento_id}: ${plan.pi.id}`);
          continue;
        }

        const idempotencyKey =
          `turentu-corsa-${corsa_id}-pagamento-${pren.pagamento_id}-capture-v1`;

        const captured = await stripe.paymentIntents.capture(
          pren.stripe_payment_intent,
          { amount_to_capture: amountInCents },
          { idempotencyKey }
        );

        const received = Number(captured?.amount_received);
        if (captured?.status !== 'succeeded' ||
            !Number.isSafeInteger(received) ||
            received !== amountInCents) {
          throw new Error(
            `Esito cattura non verificabile per ${pren.stripe_payment_intent}`
          );
        }

        await client.query(
          `UPDATE public.pagamenti
           SET stato = 'pagato', importo = $1, updated_at = NOW()
           WHERE id = $2`,
          [received / 100, pren.pagamento_id]
        );
      }

      console.log(
        `🏁 [CAPTURE FLOW END] Preflight e riconciliazione completati per corsa ${corsa_id}.`
      );
    }

    if (action === 'end') {
      const completata = await client.query(`
        UPDATE public.assegnazioni_conducenti
        SET stato = 'completata', aggiornata_il = NOW()
        WHERE id = $1 AND stato = 'assegnata'
        RETURNING id
      `, [assegnazioneId]);
      if (completata.rowCount !== 1) {
        throw new Error('Impossibile completare assegnazione conducente');
      }
    }

    await client.query('COMMIT');
    const result = { ...corsa, stato: newStato };
    try {
      await removeCorsa(corsa_id);
    } catch (cacheErr) {
      console.error('[POST-COMMIT REDIS CLEANUP FAILED] corsa=', corsa_id, cacheErr);
    }
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
