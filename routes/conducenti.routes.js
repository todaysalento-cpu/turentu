// Turentu: API autonoma conducenti. Montare con middleware JWT esistente.
// Il router NON importa PIXEL, POPBUS o il pool; riceve le dipendenze dal chiamante.
import { Router } from 'express';
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
export function creaRouterConducenti({ pool, authenticate }) {
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

  const route = (fn) => async (req, res) => {
    try { const result = await fn(req); res.json({ ok: true, data: result }); }
    catch (err) {
      // Errori applicativi noti e vincoli DB, senza esporre query/stack al client.
      if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ ok: false, error: err.message });
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
