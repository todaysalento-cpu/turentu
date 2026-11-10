import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { CacheManager } from '../utils/cacheManager.js';
import { upsertCorsa } from '../services/search/search.cache.js';
import { accettaAttivazione } from '../services/popbus/v2/acceptance.js';
import { accettaOffertaPopbusAR } from '../services/popbus/v2/popbus-ar-orchestrator.service.js';

const router = express.Router();
router.use(authMiddleware);

function idPositivo(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function pubblicaCorsa(corsa, operatoreId) {
  try { CacheManager.corsa.update(corsa); }
  catch (e) { console.error('[POPBUS CACHE]', e); }
  try { upsertCorsa(corsa); }
  catch (e) { console.error('[POPBUS SEARCH CACHE]', e); }
  try { getIO().to(`autista_${operatoreId}`).emit('nuova_corsa_popbus', corsa); }
  catch (e) { console.error('[POPBUS SOCKET]', e); }
}

router.get('/offerte/veicolo/:veicolo_id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.attivazione_id, a.direttrice_id, a.veicolo_id, a.autista_id,
        a.partenza AS orario, a.ricavo AS prezzo,
        a.piano->>'classe' AS classe,
        a.piano->'evaluation'->>'peak' AS posti_richiesti,
        a.piano->'coordinates'->0->>'nome_nodo' AS origine_address,
        a.piano->'coordinates'->-1->>'nome_nodo' AS destinazione_address,
        o.expires_at
      FROM offerte_autisti o
      JOIN popbus_attivazioni a ON a.id = o.attivazione_id
      JOIN veicolo v ON v.id = a.veicolo_id
      WHERE o.autista_id = $1 AND v.driver_id = $1 AND v.id = $2
        AND o.stato = 'inviata' AND a.stato = 'in_attesa_autista'
        AND o.expires_at > NOW()
    `, [req.user.id, req.params.veicolo_id]);
    res.json({ offerte: rows });
  } catch (e) {
    console.error('[POPBUS OFFERTE]', e);
    res.status(500).json({ error: 'Errore caricamento offerte' });
  }
});

// Una richiesta vincolata A/R attiva identifica il percorso atomico.
// L'identita' operatore/offerta/veicolo e' verificata anche dall'orchestratore.
async function identificaOfferta(offertaId) {
  const { rows } = await pool.query(`
    SELECT o.attivazione_id,
      EXISTS (
        SELECT 1
        FROM popbus_attivazione_richieste par
        JOIN richieste_pop_bus r ON r.id = par.richiesta_id
        WHERE par.attivazione_id = o.attivazione_id
          AND par.attiva = TRUE AND r.ar_vincolata IS TRUE
      ) AS ar_vincolata
    FROM offerte_autisti o
    WHERE o.id = $1
  `, [offertaId]);
  return rows[0] ?? null;
}

// Ricostruisce entrambe le corse anche nel caso di retry idempotente,
// in cui l'orchestratore restituisce soltanto corsa_id della tratta richiesta.
async function corseConfermateAR(attivazioneId) {
  const { rows } = await pool.query(`
    SELECT DISTINCT a.id AS attivazione_id, a.corsa_id
    FROM popbus_attivazione_richieste par_root
    JOIN richieste_pop_bus r_root ON r_root.id = par_root.richiesta_id
    JOIN richieste_pop_bus r_peer
      ON r_peer.ar_group_id = r_root.ar_group_id
      AND r_peer.ar_vincolata IS TRUE
    JOIN popbus_attivazione_richieste par_peer
      ON par_peer.richiesta_id = r_peer.id AND par_peer.attiva = TRUE
    JOIN popbus_attivazioni a ON a.id = par_peer.attivazione_id
    WHERE par_root.attivazione_id = $1 AND par_root.attiva = TRUE
      AND r_root.ar_vincolata IS TRUE
      AND a.stato = 'confermata' AND a.corsa_id IS NOT NULL
    ORDER BY a.id
  `, [attivazioneId]);
  if (rows.length !== 2 || rows.some(r => !idPositivo(r.corsa_id))) {
    const error = new Error('Corse A/R confermate non coerenti');
    error.status = 409;
    throw error;
  }
  return rows.map(r => ({ attivazione_id: Number(r.attivazione_id), corsa_id: Number(r.corsa_id) }));
}

router.post('/:offerta_id/accetta', async (req, res) => {
  const offertaId = idPositivo(req.params.offerta_id);
  const operatoreId = idPositivo(req.user?.id);
  if (!offertaId || !operatoreId) {
    return res.status(400).json({ error: 'Identificativi non validi' });
  }

  try {
    const offerta = await identificaOfferta(offertaId);
    if (!offerta) return res.status(404).json({ error: 'Offerta non trovata' });

    if (offerta.ar_vincolata) {
      if (process.env.POPBUS_AR_FINALIZATION_ENABLED !== 'true') {
        return res.status(503).json({ error: 'Accettazione A/R non ancora disponibile', code: 'POPBUS_AR_DISABLED' });
      }
      const risultato = await accettaOffertaPopbusAR({
        attivazioneId: Number(offerta.attivazione_id),
        offertaId,
        operatoreId,
        sceltaConducente: req.body?.conducente ?? null
      });
      if (risultato.stato === 'in_attesa') {
        return res.status(202).json({
          ok: true, tipo: 'ar', stato: 'in_attesa',
          attivazione_id: Number(offerta.attivazione_id),
          accettazione_id: risultato.accettazioneId,
          accettazioni_mancanti: risultato.accettazioniMancanti ?? []
        });
      }
      if (risultato.stato !== 'confermato') {
        throw Object.assign(new Error('Stato A/R inatteso'), { status: 409 });
      }

      const corse = await corseConfermateAR(Number(offerta.attivazione_id));
      // Solo il processo che ha effettivamente creato le corse dispone
      // degli oggetti completi. Il retry non deve generare eventi duplicati.
      if (!risultato.giaConfermato && Array.isArray(risultato.corse)) {
        for (const item of risultato.corse) {
          if (item?.corsa && idPositivo(item.corsa.id)) pubblicaCorsa(item.corsa, operatoreId);
        }
      }
      return res.json({
        ok: true, tipo: 'ar', stato: 'confermato',
        gia_confermato: risultato.giaConfermato === true,
        attivazione_id: Number(offerta.attivazione_id),
        corse,
        gruppi: risultato.gruppi ?? []
      });
    }

    // Percorso POPBUS ordinario: conserva la transazione e la risposta storiche.
    const client = await pool.connect();
    let tx = false;
    try {
      await client.query('BEGIN');
      tx = true;
      const corsa = await accettaAttivazione(client, offertaId, operatoreId, req.body?.conducente ?? null);
      await client.query('COMMIT');
      tx = false;
      if (!corsa.giaAccettata) pubblicaCorsa(corsa, operatoreId);
      return res.json({ ok: true, corsa_id: corsa.id });
    } catch (e) {
      if (tx) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { console.error('[POPBUS ROLLBACK]', rollbackError); }
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[POPBUS ACCETTA]', e);
    const status = [400, 401, 403, 404, 409, 423, 503].includes(Number(e.status))
      ? Number(e.status) : 409;
    return res.status(status).json({ error: e.message, code: e.code ?? 'POPBUS_ACCEPT_ERROR' });
  }
});

export { router as popbusRouter };
