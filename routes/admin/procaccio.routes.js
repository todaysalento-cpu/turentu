import express from 'express';
import { pool } from '../../db/db.js';

const router = express.Router();
const FIELDS = ['ragione_sociale','partita_iva','comune','provincia','regione','indirizzo','telefono','email','sito_web','stato','fonte','procacciatore_id','prossimo_contatto_il','note'];
const STATES = new Set(['da_contattare','contattato','interessato','in_trattativa','aderito','non_interessato','non_raggiungibile']);
const parseId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};
const bad = (message) => Object.assign(new Error(message), { status: 400 });

function validate(body, create = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Dati operatore non validi');
  const data = {};
  for (const [field, value] of Object.entries(body)) {
    if (!FIELDS.includes(field)) throw bad(`Campo non consentito: ${field}`);
    if (field === 'procacciatore_id') {
      if (value === null || value === '') data[field] = null;
      else {
        const id = parseId(value);
        if (!id) throw bad('Procacciatore non valido');
        data[field] = id;
      }
      continue;
    }
    if (value !== null && typeof value !== 'string') throw bad(`Valore non valido per ${field}`);
    data[field] = value === null ? null : (value.trim() || null);
  }
  if (create && !data.ragione_sociale) throw bad('Ragione sociale obbligatoria');
  if ('ragione_sociale' in data && !data.ragione_sociale) throw bad('Ragione sociale obbligatoria');
  if ('stato' in data && (!data.stato || !STATES.has(data.stato))) throw bad('Stato commerciale non valido');
  if (data.partita_iva && !/^\d{11}$/.test(data.partita_iva)) throw bad('Partita IVA non valida');
  if (data.prossimo_contatto_il && Number.isNaN(Date.parse(data.prossimo_contatto_il))) throw bad('Data prossimo contatto non valida');
  return data;
}

function respondError(err, res) {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Dato duplicato o vincolo di unicità' });
  if (err.code === '23503') return res.status(400).json({ error: 'Procacciatore inesistente' });
  if (['23514','22007','22008','22001','22P02'].includes(err.code)) return res.status(400).json({ error: 'Dati non validi' });
  console.error('Procaccio Navette:', err);
  return res.status(500).json({ error: 'Errore interno server' });
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Rollback Procaccio:', rollbackError); }
    throw err;
  } finally {
    client.release();
  }
}

async function history(client, id, action, req, details = null) {
  await client.query(
    `INSERT INTO public.procaccio_storico (operatore_id, azione, dettagli, autore_tipo, autore_id)
     VALUES ($1, $2, $3::jsonb, 'admin', $4)`,
    [id, action, JSON.stringify(details), parseId(req.user?.id)]
  );
}

// GET /api/admin/procaccio/operatori
router.get('/operatori', async (req, res) => {
  try {
    const { ricerca = '', stato = '', provincia = '', pagina = '1', limite = '20' } = req.query;
    if ([ricerca, stato, provincia].some(v => typeof v !== 'string')) throw bad('Filtri non validi');
    const page = Number(pagina), pageSize = Number(limite);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw bad('Parametri di paginazione non validi');
    const params = [], filters = ['o.archiviato_il IS NULL'];
    if (ricerca.trim()) {
      params.push(`%${ricerca.trim()}%`);
      filters.push(`(o.ragione_sociale ILIKE $${params.length} OR o.telefono ILIKE $${params.length} OR o.email ILIKE $${params.length})`);
    }
    if (stato.trim()) { params.push(stato.trim()); filters.push(`o.stato = $${params.length}`); }
    if (provincia.trim()) { params.push(provincia.trim()); filters.push(`o.provincia = $${params.length}`); }
    const where = `WHERE ${filters.join(' AND ')}`;
    const count = await pool.query(`SELECT COUNT(*)::int AS totale FROM public.procaccio_operatori o ${where}`, params);
    const data = await pool.query(
      `SELECT o.*, p.nome AS procacciatore_nome, p.cognome AS procacciatore_cognome,
              COALESCE(f.totale_mezzi, 0)::int AS totale_mezzi
       FROM public.procaccio_operatori o
       LEFT JOIN public.procaccio_procacciatori p ON p.id = o.procacciatore_id
       LEFT JOIN (SELECT operatore_id, SUM(quantita) AS totale_mezzi FROM public.procaccio_flotte GROUP BY operatore_id) f ON f.operatore_id = o.id
       ${where} ORDER BY o.creato_il DESC, o.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    return res.json({ operatori: data.rows, totale: count.rows[0].totale, pagina: page, limite: pageSize });
  } catch (err) { return respondError(err, res); }
});

// POST /api/admin/procaccio/operatori
router.post('/operatori', async (req, res) => {
  try {
    const data = validate(req.body, true);
    const operatore = await withTransaction(async client => {
      const fields = Object.keys(data), values = Object.values(data);
      const result = await client.query(
        `INSERT INTO public.procaccio_operatori (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, values
      );
      await history(client, result.rows[0].id, 'creazione_operatore', req, { stato: result.rows[0].stato });
      return result.rows[0];
    });
    return res.status(201).json({ operatore });
  } catch (err) { return respondError(err, res); }
});

// GET /api/admin/procaccio/operatori/:id
router.get('/operatori/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID operatore non valido' });
  try {
    const operator = await pool.query(
      `SELECT o.*, p.nome AS procacciatore_nome, p.cognome AS procacciatore_cognome
       FROM public.procaccio_operatori o LEFT JOIN public.procaccio_procacciatori p ON p.id = o.procacciatore_id
       WHERE o.id = $1 AND o.archiviato_il IS NULL`, [id]
    );
    if (!operator.rowCount) return res.status(404).json({ error: 'Operatore non trovato' });
    const [fleet, contacts, activities] = await Promise.all([
      pool.query('SELECT * FROM public.procaccio_flotte WHERE operatore_id = $1 ORDER BY tipologia', [id]),
      pool.query('SELECT * FROM public.procaccio_contatti WHERE operatore_id = $1 ORDER BY principale DESC, id', [id]),
      pool.query('SELECT * FROM public.procaccio_attivita WHERE operatore_id = $1 ORDER BY creato_il DESC, id DESC', [id])
    ]);
    return res.json({ operatore: operator.rows[0], flotta: fleet.rows, contatti: contacts.rows, attivita: activities.rows });
  } catch (err) { return respondError(err, res); }
});

// PATCH /api/admin/procaccio/operatori/:id
router.patch('/operatori/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID operatore non valido' });
  try {
    const data = validate(req.body);
    const fields = Object.keys(data);
    if (!fields.length) throw bad('Nessun campo da aggiornare');
    const result = await withTransaction(async client => {
      const previous = await client.query('SELECT * FROM public.procaccio_operatori WHERE id = $1 AND archiviato_il IS NULL FOR UPDATE', [id]);
      if (!previous.rowCount) return null;
      const changes = {};
      for (const field of fields) {
        const before = previous.rows[0][field], after = data[field];
        const normalizedBefore = before instanceof Date ? before.toISOString() : before;
        const normalizedAfter = field === 'prossimo_contatto_il' && after ? new Date(after).toISOString() : after;
        if (String(normalizedBefore ?? '') !== String(normalizedAfter ?? '')) changes[field] = { precedente: normalizedBefore, nuovo: normalizedAfter };
      }
      if (!Object.keys(changes).length) return { operatore: previous.rows[0], modificato: false };
      const updated = await client.query(
        `UPDATE public.procaccio_operatori SET ${fields.map((field, i) => `${field} = $${i + 1}`).join(', ')}, aggiornato_il = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
        [...Object.values(data), id]
      );
      await history(client, id, 'aggiornamento_operatore', req, { modifiche: changes });
      return { operatore: updated.rows[0], modificato: true };
    });
    if (!result) return res.status(404).json({ error: 'Operatore non trovato' });
    return res.json(result);
  } catch (err) { return respondError(err, res); }
});

// PATCH /api/admin/procaccio/operatori/:id/archivia
router.patch('/operatori/:id/archivia', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID operatore non valido' });
  try {
    const operatore = await withTransaction(async client => {
      const updated = await client.query(
        'UPDATE public.procaccio_operatori SET archiviato_il = NOW(), aggiornato_il = NOW() WHERE id = $1 AND archiviato_il IS NULL RETURNING *', [id]
      );
      if (!updated.rowCount) return null;
      await history(client, id, 'archiviazione_operatore', req);
      return updated.rows[0];
    });
    if (!operatore) return res.status(404).json({ error: 'Operatore non trovato o già archiviato' });
    return res.json({ archiviato: true, operatore });
  } catch (err) { return respondError(err, res); }
});

// GET /api/admin/procaccio/operatori/:id/storico
router.get('/operatori/:id/storico', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID operatore non valido' });
  try {
    const operator = await pool.query('SELECT id FROM public.procaccio_operatori WHERE id = $1', [id]);
    if (!operator.rowCount) return res.status(404).json({ error: 'Operatore non trovato' });
    const result = await pool.query('SELECT * FROM public.procaccio_storico WHERE operatore_id = $1 ORDER BY creato_il DESC, id DESC', [id]);
    return res.json({ storico: result.rows });
  } catch (err) { return respondError(err, res); }
});

export default router;