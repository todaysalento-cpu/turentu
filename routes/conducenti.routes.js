import { ottieniContestoMappaNcc } from '../services/ncc-mappa-contesto.service.js';
// Turentu: API autonoma conducenti. Montare con middleware JWT esistente.
// Il router NON importa PIXEL, POPBUS o il pool; riceve le dipendenze dal chiamante.
import { Router } from 'express';

// NCC_GEOGRAFIA_API_V2902B
import {
  confermaPuntoGoogleNcc,
  confermaPuntoManualeNcc,
  riepilogoGeografiaNcc,
  anteprimaGeografiaImportNcc,
  validaGeografiaPrenotazioniNcc
} from '../services/ncc-geografia-prenotazioni.service.js';
import { importaPrenotazioni, pianificatore, approvaGruppo, approvaMissione, salvaParametriPianificatore, eliminaGruppo, simulazioneNccV26 } from '../services/ncc-import-planner.service.js';
import {
  elencaPrenotazioniEsterne, creaPrenotazioneEsterna,
  modificaPrenotazioneEsterna, annullaPrenotazioneEsterna, eliminaPrenotazioneEsterna, eliminaPrenotazioniEsterne
} from '../services/gestionale-ncc.service.js';
import { preparaInvitoAnagrafica, accettaInvitoAnagrafica } from '../services/conducenti/inviti-anagrafica.service.js';
import {
  elencoConducenti, invitaConducente, accettaInvitoConducente,
  rifiutaInvitoConducente, rapportoAttivoConducente,
  sospendiConducente, impostaAssegnazioneAutomatica,
  impostaSempreDisponibile, elencoInvitiConducente,
  leggiImpostazioniAssegnazione, salvaImpostazioniAssegnazione
} from '../services/conducenti/conducenti.service.js';
import {
  elencoTurni, aggiungiTurno, impostaTurnoAttivo, eliminaTurno,
  elencoEccezioni, aggiungiEccezione, eliminaEccezione
} from '../services/conducenti/turni.service.js';
import {
  elencoAssegnazioni,
  elencoAssegnazioniConducente,
  assegnaConducente
} from '../services/conducenti/assegnazioni.service.js';

import {
  elencoAnagraficheConducenti, creaAnagraficaConducente,
  modificaAnagraficaConducente, disattivaAnagraficaConducente
} from '../services/conducenti/anagrafica.service.js';

const positive = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const bool = (v) => typeof v === 'boolean';

/**
 * @param {{pool: import('pg').Pool, authenticate: Function}} dependencies
 * authenticate DEVE rifiutare JWT mancanti/non validi e impostare req.user.id.
 * In questa fase ogni operatore agisce SOLO sul proprio account (utente.id).
 */
// NCC_API_TESTABILITY_V26
export function creaRouterConducenti({
  pool,
  authenticate,
  motoreV1 = pianificatore,
  motoreV26 = simulazioneNccV26
}) {
  if (!pool?.query || typeof authenticate !== 'function') {
    throw new Error('Router conducenti: pool e authenticate obbligatori');
  }
  const router = Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    if (!positive(req.user?.id)) return res.status(401).json({ error: 'Autenticazione richiesta' });
    req.conducentiUserId = Number(req.user.id);
    next();
  });

  const route = (fn, successStatus = 200) => async (req, res) => {
    try { const result = await fn(req); res.status(successStatus).json({ ok: true, data: result }); }
    catch (err) {
      // Errori applicativi noti e vincoli DB, senza esporre query/stack al client.
      if (
        err.status === 500 &&
        err.code === 'NCC_ERRORE_PIANIFICAZIONE'
      ) {

        return res.status(500).json({
          ok: false,
          error: 'Errore interno durante la pianificazione.',
          code: 'NCC_ERRORE_PIANIFICAZIONE'
        });
      }

      if (err.status === 503) {

        return res.status(503).json({
          ok: false,
          error: 'Servizio temporaneamente non disponibile. Riprovare.',
          code: 'NCC_SERVIZIO_NON_DISPONIBILE'
        });
      }

      if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {

        const risposta = {
          ok: false,
          error: err.message
        };

        if (err.status === 429) {
          risposta.code = 'NCC_SIMULAZIONE_NON_DISPONIBILE';
        }

        return res.status(err.status).json(risposta);
      }
      if (err.code === '23P01' || err.code === '23505') {
        return res.status(409).json({ error: 'Conflitto di assegnazione o duplicato' });
      }
      if (err.code?.startsWith('23')) return res.status(409).json({ error: 'Vincolo database non rispettato' });
      if (err.code) {
        console.error('[conducenti] errore database', err);
        return res.status(500).json({ error: 'Errore database' });
      }
      return res.status(400).json({ error: err.message || 'Richiesta non valida' });
    }
  };
  const op = (req) => req.conducentiUserId;
  const id = (v, name) => {
    if (!positive(v)) throw new Error(`${name} non valido`);
    return Number(v);
  };
  const requireBool = (v, name) => {
    if (!bool(v)) throw new Error(`${name} deve essere booleano`);
    return v;
  };
  const rapporto = (req) => id(req.params.rapportoId, 'rapportoId');

  router.post('/me/inviti-anagrafica/accetta', route(req =>
    accettaInvitoAnagrafica(pool, {utenteId: op(req),token:req.body?.token})));

  router.get('/me/inviti', route(req => elencoInvitiConducente(pool, op(req))));
  router.post('/me/inviti/:rapportoId/accetta', route(req =>
    accettaInvitoConducente(pool, { rapportoId: rapporto(req), conducenteId: op(req) })));
  router.post('/me/inviti/:rapportoId/rifiuta', route(req =>
    rifiutaInvitoConducente(pool, {
      rapportoId: rapporto(req),
      conducenteId: op(req)
    })
  ));
  router.get('/me/rapporto-attivo', route(req =>
    rapportoAttivoConducente(pool, op(req))
  ));

  // Il conducente autenticato consulta esclusivamente le proprie missioni.
  router.get('/me/assegnazioni', route(req =>
    elencoAssegnazioniConducente(pool, op(req))
  ));

  // Le API operatore sono riservate agli account di tipo 'autista'.
  // Verifica sul DB: non dipende da un ruolo JWT potenzialmente non aggiornato.
  // NOTA: questo controllo non sostituisce la verifica professionale NCC.
  const requireOperatoreNcc = async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT tipo FROM utente WHERE id = $1`,
        [op(req)]
      );
      if (rows[0]?.tipo !== 'autista') {
        return res.status(403).json({
          ok: false,
          error: 'Accesso riservato agli operatori NCC'
        });
      }
      next();
    } catch (err) {
      console.error('[conducenti] verifica operatore NCC:', err);
      return res.status(500).json({
        ok: false,
        error: 'Errore verifica autorizzazione'
      });
    }
  };

  router.use('/operatori', requireOperatoreNcc);

  const prenotazioniEsterne = '/operatori/me/prenotazioni-esterne';


  // NCC_MAPPA_CONTESTO_V1
  router.post(
    prenotazioniEsterne + '/geografia/contesto-mappa',
    route(req => {
      const indirizzo = req.body?.indirizzo;

      if (
        typeof indirizzo !== 'string' ||
        !indirizzo.trim() ||
        indirizzo.length > 250
      ) {
        throw Object.assign(
          new Error('Indirizzo non valido.'),
          { status: 400 }
        );
      }

      return ottieniContestoMappaNcc(
        pool,
        indirizzo.trim()
      );
    })
  );

  // Riepilogo geografico operatore.
  router.get(
    prenotazioniEsterne + '/geografia/riepilogo',
    route(req =>
      riepilogoGeografiaNcc(pool, op(req))
    )
  );

  router.post(prenotazioniEsterne + '/geografia/anteprima-import',
    route(req => anteprimaGeografiaImportNcc(pool, op(req), req.body)));

  // Validazione massiva: massimo 10 prenotazioni.
  router.post(
    prenotazioniEsterne + '/geografia/valida',
    route(req =>
      validaGeografiaPrenotazioniNcc(
        pool,
        op(req),
        req.body ?? {}
      )
    )
  );

  router.post(prenotazioniEsterne + '/geografia/valida-massiva', async (req, res) => {
    const invia = evento => {
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.type('application/x-ndjson');
        res.set('Cache-Control', 'no-store, no-transform');
        res.set('X-Accel-Buffering', 'no');
      }
      res.write(JSON.stringify(evento) + '\n');
      res.flush?.();
    };
    try {
      const data = await validaGeografiaPrenotazioniNcc(pool, op(req), req.body ?? {}, {
        massiva: true,
        avanzamento: (esaminate, totale) => invia({ tipo: 'avanzamento', esaminate, totale })
      });
      invia({ tipo: 'esito', data });
      res.end();
    } catch (error) {
      const status = [400, 404, 429, 503].includes(error.status) ? error.status : 500;
      const message = status === 500 ? 'Errore durante la validazione geografica.' : error.message;
      if (status === 500) console.error('[NCC validazione massiva]', error.code || error.name);
      if (res.destroyed) return;
      if (res.headersSent) {
        invia({ tipo: 'errore', status, error: message });
        res.end();
      } else {
        res.status(status).json({ ok: false, error: message });
      }
    }
  });

  router.post(prenotazioniEsterne + '/:id/geografia/conferma-google', route(req => {
    const bookingId = String(req.params.id);
    if (!/^[1-9]\d{0,18}$/.test(bookingId) || BigInt(bookingId) > 9223372036854775807n) {
      throw Object.assign(new Error('Prenotazione non valida.'), { status: 400 });
    }
    return confermaPuntoGoogleNcc(pool, op(req), bookingId, req.body ?? {});
  }));


  // NCC_CONFERMA_MAPPA_V1
  router.post(
    prenotazioniEsterne + '/:id/geografia/conferma-manuale',
    route(req => {
      const bookingId = String(req.params.id);

      if (
        !/^[1-9]\d{0,18}$/.test(bookingId) ||
        BigInt(bookingId) > 9223372036854775807n
      ) {
        throw Object.assign(
          new Error('Prenotazione non valida.'),
          { status: 400 }
        );
      }

      return confermaPuntoManualeNcc(
        pool,
        op(req),
        bookingId,
        req.body ?? {}
      );
    })
  );

  // Validazione singola.
  router.post(
    prenotazioniEsterne + '/:id/geografia/valida',
    route(req =>
      validaGeografiaPrenotazioniNcc(
        pool,
        op(req),
        { ids: [req.params.id] }
      )
    )
  );

  router.post(prenotazioniEsterne + '/importa', route(req =>
    importaPrenotazioni(pool, op(req), req.body)));
  // NCC_API_ORCHESTRATORE_V26

  router.get(
    prenotazioniEsterne + '/pianificatore',
    route(async req => {

      if (req.query.motore === 'V2') {

        if (req.query.modalita !== 'simulazione') {

          throw Object.assign(
            new Error(
              'Il motore V2 e disponibile solo in simulazione.'
            ),
            { status: 400 }
          );
        }

        // NCC_API_HARDENING_V26

        try {

          // NCC_API_CPSAT_V286G4

          const cpsatAttivo =
            process.env.NCC_CPSAT_ADATTIVO_ENABLED === 'true';

          return await motoreV26(
            pool,
            op(req),
            req.query.giorno,

            ...(cpsatAttivo
              ? [{
                  schedulazioneTemporale: true,
                  reinserimentoDinamico: true,
                  aggregazioneAdattiva: true,
                  cpsatAdattivo: true
                }]
              : [])
          );

        } catch (err) {

          if (err?.status === 400) {

            throw Object.assign(
              new Error('Giornata simulazione non valida.'),
              { status: 400 }
            );
          }

          if (err?.status === 429) {

            throw Object.assign(
              new Error(
                'Pianificatore temporaneamente non disponibile.'
              ),
              { status: 429 }
            );
          }

          if (
            err?.status === 503 ||
            [
              'NCC_LEASE_PERSO',
              'NCC_SESSION_TIMEOUT',
              'NCC_ROUTING_INTERROTTO'
            ].includes(err?.message)
          ) {

            console.warn(
              '[NCC V26] Sessione interrotta:',
              op(req),
              err?.message
            );

            throw Object.assign(
              new Error('Servizio temporaneamente non disponibile.'),
              { status: 503 }
            );
          }

          console.error(
            '[NCC V26] Errore pianificazione:',
            {
              operatore: op(req),
              giorno: req.query.giorno,
              errore: err?.name,
              codice: err?.code,
              messaggio: err?.message
            }
          );

          throw Object.assign(
            new Error(
              'Errore interno durante la pianificazione.'
            ),
            {
              status: 500,
              code: 'NCC_ERRORE_PIANIFICAZIONE'
            }
          );
        }
      }

      return motoreV1(
        pool,
        op(req),
        {
          modalita: req.query.modalita,
          giorno: req.query.giorno
        }
      );
    })
  );
  router.put(prenotazioniEsterne + '/pianificatore/parametri', route(req =>
    salvaParametriPianificatore(pool, op(req), req.body)));
  router.delete(prenotazioniEsterne + '/pianificatore/gruppi/:gruppoId', route(req =>
    eliminaGruppo(pool, op(req), req.params.gruppoId)));
  router.post(prenotazioniEsterne + '/pianificatore/missioni/approva', route(req =>
    approvaMissione(pool, op(req), req.body), 201));
  router.post(prenotazioniEsterne + '/pianificatore/approva', route(req =>
    approvaGruppo(pool, op(req), req.body?.prenotazioni), 201));
  router.get(prenotazioniEsterne, route(req =>
    elencaPrenotazioniEsterne(pool, op(req), req.query)));
  router.post(prenotazioniEsterne, route(req =>
    creaPrenotazioneEsterna(pool, op(req), req.body), 201));
  router.put(prenotazioniEsterne + '/:id', route(req =>
    modificaPrenotazioneEsterna(pool, op(req), id(req.params.id, 'Prenotazione'), req.body)));
  router.post(prenotazioniEsterne + '/elimina-multiple', route(req =>
    eliminaPrenotazioniEsterne(pool, op(req), req.body?.ids)));
  router.delete(prenotazioniEsterne + '/:id', route(req =>
    eliminaPrenotazioneEsterna(pool, op(req), req.params.id)));
  router.post(prenotazioniEsterne + '/:id/annulla', route(req =>
    annullaPrenotazioneEsterna(pool, op(req), id(req.params.id, 'Prenotazione'))));

  // Preferenza generale dell'operatore, indipendente dai singoli conducenti.
  router.get('/operatori/me/impostazioni-assegnazione', route(req =>
    leggiImpostazioniAssegnazione(pool, op(req))));
  router.patch('/operatori/me/impostazioni-assegnazione', route(req => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !Object.hasOwn(body, 'modalita')) {
      const err = new Error('Specificare esclusivamente il campo modalita');
      err.status = 400;
      throw err;
    }
    return salvaImpostazioniAssegnazione(pool, {
      operatoreId: op(req), modalita: body.modalita
    });
  }));

  // Anagrafiche non registrate: gestione isolata dai rapporti e dalle assegnazioni.
  router.get('/operatori/me/anagrafiche-conducenti', route(req =>
    elencoAnagraficheConducenti(pool, op(req))));
  router.post('/operatori/me/anagrafiche-conducenti', route(req =>
    creaAnagraficaConducente(pool, { operatoreId: op(req), body: req.body })));
  router.patch('/operatori/me/anagrafiche-conducenti/:anagraficaId', route(req =>
    modificaAnagraficaConducente(pool, {
      operatoreId: op(req), anagraficaId: id(req.params.anagraficaId, 'anagraficaId'), body: req.body
    })));
  router.patch('/operatori/me/anagrafiche-conducenti/:anagraficaId/disattiva', route(req =>
    disattivaAnagraficaConducente(pool, {
      operatoreId: op(req), anagraficaId: id(req.params.anagraficaId, 'anagraficaId')
    })));

  router.post('/operatori/me/anagrafiche-conducenti/:anagraficaId/invita', route(req =>
    preparaInvitoAnagrafica(pool, {operatoreId:op(req),
      anagraficaId:id(req.params.anagraficaId,'anagraficaId'),
      baseUrl:process.env.TURENTU_INVITE_BASE_URL})));

  router.get('/operatori/me/conducenti', route(req => elencoConducenti(pool, op(req))));
  router.post('/operatori/me/conducenti/inviti', route(req =>
    invitaConducente(pool, { operatoreId: op(req), conducenteId: id(req.body?.conducenteId, 'conducenteId') })));
  router.patch('/operatori/me/conducenti/:rapportoId/sospendi', route(req =>
    sospendiConducente(pool, { operatoreId: op(req), rapportoId: rapporto(req) })));
  router.patch('/operatori/me/conducenti/:rapportoId/automatico', route(req =>
    impostaAssegnazioneAutomatica(pool, {
      operatoreId: op(req), rapportoId: rapporto(req),
      abilitata: requireBool(req.body?.abilitata, 'abilitata')
    })));

  router.patch('/operatori/me/conducenti/:rapportoId/sempre-disponibile', route(req =>
    impostaSempreDisponibile(pool, {
      operatoreId: op(req), rapportoId: rapporto(req),
      sempreDisponibile: requireBool(req.body?.sempreDisponibile, 'sempreDisponibile')
    })));

  router.get('/operatori/me/conducenti/:rapportoId/turni', route(req =>
    elencoTurni(pool, { operatoreId: op(req), rapportoId: rapporto(req) })));
  router.post('/operatori/me/conducenti/:rapportoId/turni', route(req =>
    aggiungiTurno(pool, { operatoreId: op(req), rapportoId: rapporto(req),
      giornoSettimana: req.body?.giornoSettimana, oraInizio: req.body?.oraInizio, oraFine: req.body?.oraFine })));
  router.patch('/operatori/me/conducenti/:rapportoId/turni/:turnoId', route(req =>
    impostaTurnoAttivo(pool, { operatoreId: op(req), rapportoId: rapporto(req),
      turnoId: id(req.params.turnoId, 'turnoId'), attivo: requireBool(req.body?.attivo, 'attivo') })));
  router.delete('/operatori/me/conducenti/:rapportoId/turni/:turnoId', route(req =>
    eliminaTurno(pool, { operatoreId: op(req), rapportoId: rapporto(req), turnoId: id(req.params.turnoId, 'turnoId') })));

  router.get('/operatori/me/conducenti/:rapportoId/eccezioni', route(req =>
    elencoEccezioni(pool, { operatoreId: op(req), rapportoId: rapporto(req) })));
  router.post('/operatori/me/conducenti/:rapportoId/eccezioni', route(req =>
    aggiungiEccezione(pool, { operatoreId: op(req), rapportoId: rapporto(req),
      inizio: req.body?.inizio, fine: req.body?.fine, tipo: req.body?.tipo, nota: req.body?.nota })));
  router.delete('/operatori/me/conducenti/:rapportoId/eccezioni/:eccezioneId', route(req =>
    eliminaEccezione(pool, { operatoreId: op(req), rapportoId: rapporto(req),
      eccezioneId: id(req.params.eccezioneId, 'eccezioneId') })));

  // Scrittura NCC manuale: nessun intervallo ricevuto dal client viene usato.
  // Non abilita l'assegnazione POPBUS ne' l'assegnazione automatica.
  router.post('/operatori/me/assegnazioni', route(async req => {
    const body = req.body ?? {};
    const chiaviAmmesse = new Set(['corsaId', 'veicoloId', 'conducenteId',
      'confermaDeroga', 'motivoDeroga']);
    if (Object.keys(body).some(k => !chiaviAmmesse.has(k))) {
      throw new Error('Campi non ammessi nella richiesta');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const risultato = await assegnaConducente(client, {
        operatoreId: op(req),
        veicoloId: id(body.veicoloId, 'veicoloId'),
        corsaId: id(body.corsaId, 'corsaId'),
        conducenteId: id(body.conducenteId, 'conducenteId'),
        modalita: 'manuale',
        usaCicloPersistito: true,
        confermaDeroga: body.confermaDeroga === true,
        motivoDeroga: body.motivoDeroga,
        autorizzatoreId: body.confermaDeroga === true ? op(req) : null
      });
      await client.query('COMMIT');
      return risultato;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { console.error('[conducenti] rollback:', rollbackError); }
      throw error;
    } finally {
      client.release();
    }
  }));

  // Consultazione assegnazioni per operatore.
  router.get('/operatori/me/assegnazioni', route(req =>
    elencoAssegnazioni(pool, { operatoreId: op(req),
      conducenteId: req.query.conducenteId == null ? null : id(req.query.conducenteId, 'conducenteId') })));

  return router;
}
