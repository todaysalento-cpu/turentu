import { Router } from 'express';
import { pool } from '../../db/db.js';
import { disconnectAccountSockets } from '../../socket.js';
import { anonymizeAccount } from '../../services/auth/anonymize-account.service.js';
import { processAccountRemovals } from '../../services/auth/account-removals.service.js';

const router = Router();
const parseId = value => /^\d+$/.test(String(value)) && Number(value) > 0 &&
  Number(value) <= 2147483647 ? Number(value) : null;

function handle(handler) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID utente non valido.' });
    if (id === Number(req.user.id)) return res.status(403).json({ error: 'Non puoi eliminare il tuo account da questa schermata.' });
    try {
      await handler(req, res, id);
    } catch (error) {
      console.error('Eliminazione utente admin:', error.code || error.name);
      if (['55P03', '23503', '40001', '40P01'].includes(error.code)) {
        return res.status(409).json({ error: 'Account o dati collegati in uso. Riprova.' });
      }
      res.status(500).json({ error: 'Impossibile completare l’eliminazione.' });
    }
  };
}

async function isAdmin(db, id, lock = false) {
  const { rowCount } = await db.query(`
    SELECT id FROM utente WHERE id = $1 AND lower(btrim(tipo)) = 'admin'
      AND eliminato_il IS NULL ${lock ? 'FOR SHARE' : ''}
  `, [id]);
  return rowCount > 0;
}

async function activeCommitments(db, id) {
  const { rows } = await db.query(`
    WITH commitments AS (
      SELECT 'corse_attive' AS relation, 'corsa' AS tipo, c.id::text AS id,
        c.stato::text AS stato, c.start_datetime::timestamptz AS data
      FROM corse c JOIN veicolo v ON v.id = c.veicolo_id
      WHERE (c.stato = 'in_corso' OR (
        c.stato IN ('prenotabile', 'accettata', 'da_attivare') AND coalesce(c.fine_ciclo_operativo, c.arrivo_datetime,
          c.start_datetime + c.durata, c.start_datetime) >= now()
      )) AND (v.driver_id = $1 OR EXISTS (
        SELECT 1 FROM prenotazioni p WHERE p.corsa_id = c.id AND p.cliente_id = $1
      ))
      UNION ALL
      SELECT 'richieste_attive', 'richiesta', p.id::text, p.stato::text, p.expires_at::timestamptz
      FROM pending p JOIN veicolo v ON v.id = p.veicolo_id
      WHERE p.stato = 'pending' AND p.expires_at > now()
        AND (p.cliente_id = $1 OR v.driver_id = $1)
      UNION ALL
      SELECT 'popbus_attivo', 'riserva_popbus', r.id::text, r.stato::text, r.expires_at::timestamptz
      FROM popbus_riserve r JOIN corse c ON c.id = r.corsa_id
      JOIN veicolo v ON v.id = c.veicolo_id
      WHERE r.stato = 'riservata' AND r.expires_at > now()
        AND (r.cliente_id = $1 OR v.driver_id = $1)
      UNION ALL
      SELECT 'popbus_attivo', 'attivazione_popbus', a.id::text, a.stato::text, a.arrivo::timestamptz
      FROM popbus_attivazioni a
      WHERE a.autista_id = $1 AND a.stato IN ('in_attesa_autista', 'confermata') AND a.arrivo >= now()
      UNION ALL
      SELECT 'popbus_attivo', 'richiesta_popbus', r.id::text, r.stato::text, r.start_datetime::timestamptz
      FROM richieste_pop_bus r
      WHERE r.cliente_id = $1 AND r.stato IN ('in_attesa', 'in_lavorazione') AND r.start_datetime >= now()
      UNION ALL
      SELECT 'assegnazioni_attive', 'assegnazione', a.id::text, a.stato::text, upper(a.intervallo_operativo)
      FROM assegnazioni_conducenti a
      WHERE (a.operatore_id = $1 OR a.conducente_id = $1) AND a.stato = 'assegnata'
        AND upper(a.intervallo_operativo) > now()
    ), ranked AS (
      SELECT *, count(*) OVER (PARTITION BY relation)::int AS totale,
        row_number() OVER (PARTITION BY relation ORDER BY data DESC NULLS LAST, tipo, id) AS posizione
      FROM commitments
    )
    SELECT relation, tipo, id, stato, data, totale FROM ranked
    WHERE posizione <= 10 ORDER BY relation, posizione
  `, [id]);
  return rows;
}

function describeCommitments(commitments) {
  return {
    dipendenze: [...new Set(commitments.map(item => item.relation))],
    blocchi: commitments,
  };
}

router.get('/utenti/:id/eliminazione', handle(async (req, res, id) => {
  if (!await isAdmin(pool, req.user.id)) return res.status(403).json({ error: 'Permesso amministrativo non valido.' });
  const { rows: [target] } = await pool.query(`
    SELECT eliminato_il FROM utente WHERE id = $1 AND lower(btrim(tipo)) IN ('cliente', 'autista')
  `, [id]);
  if (!target) return res.status(404).json({ error: 'Utente non trovato.' });
  const { rows: [files] } = await pool.query(`
    SELECT count(*) FILTER (WHERE stato <> 'eliminato')::int AS in_attesa,
      count(*) FILTER (WHERE stato = 'manuale')::int AS manuali
    FROM admin_rimozioni_file_utenti WHERE utente_id = $1
  `, [id]);
  const commitments = target.eliminato_il ? [] : await activeCommitments(pool, id);
  res.json({ eliminabile: !target.eliminato_il && !commitments.length, eliminato: Boolean(target.eliminato_il),
    modalita: 'anonimizzazione', ...describeCommitments(commitments), file: files });
}));

router.delete('/utenti/:id', handle(async (req, res, id) => {
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer || (req.cookies?.token && req.cookies.token !== bearer)) {
    return res.status(403).json({ error: 'Per eliminare un account è richiesta l’autenticazione Bearer.' });
  }
  if (!req.is('application/json') || req.body?.conferma !== String(id)) {
    return res.status(400).json({ error: 'Inserisci l’ID esatto dell’utente per confermare.' });
  }
  const db = await pool.connect();
  let target;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    if (!await isAdmin(db, req.user.id, true)) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Permesso amministrativo non valido.' });
    }
    const { rows } = await db.query(`
      SELECT id, lower(btrim(tipo)) AS role, eliminato_il FROM utente
      WHERE id = $1 AND lower(btrim(tipo)) IN ('cliente', 'autista') FOR UPDATE
    `, [id]);
    target = rows[0];
    if (!target) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Utente non trovato.' });
    }
    if (!target.eliminato_il) {
      await db.query('SELECT id FROM veicolo WHERE driver_id = $1 ORDER BY id FOR UPDATE', [id]);
      const commitments = await activeCommitments(db, id);
      if (commitments.length) {
        const details = describeCommitments(commitments);
        await db.query(`
          INSERT INTO admin_eliminazioni_utenti (admin_id, utente_id, esito, dipendenze)
          VALUES ($1, $2, 'bloccato', $3)
        `, [req.user.id, id, details.dipendenze]);
        await db.query('COMMIT');
        return res.status(409).json({ error: 'Sono presenti impegni operativi che bloccano l’eliminazione dell’account.',
          ...details });
      }
      await db.query("SET LOCAL turentu.anonimizzazione = 'on'");
      await anonymizeAccount(db, id);
      await db.query(`
        INSERT INTO admin_eliminazioni_utenti (admin_id, utente_id, esito)
        VALUES ($1, $2, 'anonimizzato')
      `, [req.user.id, id]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  try {
    disconnectAccountSockets(target.id, target.role);
  } catch (error) {
    console.error('Disconnessione socket dopo eliminazione:', error.name);
  }
  // La coda persistente consente di riprovare dopo un riavvio o un guasto esterno.
  void processAccountRemovals().catch(error => console.error('Pulizia account:', error.name));
  res.json({ eliminato: true, anonimizzato: true,
    message: 'Account eliminato. Lo storico commerciale è conservato con un identificativo anonimizzato. La rimozione dei file esterni viene elaborata separatamente.' });
}));

export default router;
