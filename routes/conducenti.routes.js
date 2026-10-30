// Turentu: API autonoma conducenti. Montare con middleware JWT esistente.
// Il router NON importa PIXEL, POPBUS o il pool; riceve le dipendenze dal chiamante.
import { Router } from 'express';
import {
  elencoConducenti, invitaConducente, accettaInvitoConducente,
  rifiutaInvitoConducente, rapportoAttivoConducente,
  sospendiConducente, impostaAssegnazioneAutomatica, elencoInvitiConducente
} from '../services/conducenti/conducenti.service.js';
import {
  elencoTurni, aggiungiTurno, impostaTurnoAttivo, eliminaTurno,
  elencoEccezioni, aggiungiEccezione, eliminaEccezione
} from '../services/conducenti/turni.service.js';
import {
  elencoAssegnazioni,
  elencoAssegnazioniConducente
} from '../services/conducenti/assegnazioni.service.js';

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

  // Solo lettura: scrittura assegnazioni da abilitare DOPO verifica intervalli
  // operativi autorevoli, stato delle corse e autorizzazioni NCC.
  router.get('/operatori/me/assegnazioni', route(req =>
    elencoAssegnazioni(pool, { operatoreId: op(req),
      conducenteId: req.query.conducenteId == null ? null : id(req.query.conducenteId, 'conducenteId') })));

  return router;
}
