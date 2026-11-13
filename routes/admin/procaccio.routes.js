import express from 'express';
import { pool } from '../../db/db.js';

const router = express.Router();
const FIELDS = ['ragione_sociale','partita_iva','comune','provincia','regione','indirizzo','telefono','email','sito_web','stato','fonte','procacciatore_id','prossimo_contatto_il','note','piattaforma_app','fascia_contatto'];
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
  if (data.fascia_contatto && !['mattina', 'pomeriggio'].includes(data.fascia_contatto)) throw bad('Fascia di contatto non valida');
  if (data.piattaforma_app && !['android', 'ios'].includes(data.piattaforma_app)) throw bad('Piattaforma app non valida');
  if (data.partita_iva && !/^\d{11}$/.test(data.partita_iva)) throw bad('Partita IVA non valida');
  if (data.prossimo_contatto_il && Number.isNaN(Date.parse(data.prossimo_contatto_il))) throw bad('Data prossimo contatto non valida');
  return data;
}

const FLOTTA_FIELDS = ['tipologia', 'quantita', 'note'];
function validateFlotta(body, create = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Dati flotta non validi');
  const data = {};
  for (const [field, value] of Object.entries(body)) {
    if (!FLOTTA_FIELDS.includes(field)) throw bad(`Campo flotta non consentito: ${field}`);
    if (field === 'quantita') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw bad('Quantita non valida');
      data.quantita = value;
    } else if (field === 'tipologia') {
      if (typeof value !== 'string' || !value.trim()) throw bad('Tipologia obbligatoria');
      data.tipologia = value.trim();
    } else {
      if (value !== null && typeof value !== 'string') throw bad('Note non valide');
      data.note = value === null ? null : (value.trim() || null);
    }
  }
  if (create && !data.tipologia) throw bad('Tipologia obbligatoria');
  return data;
}

const CONTATTO_FIELDS = [
  'nome', 'cognome', 'ruolo', 'telefono',
  'email', 'principale', 'note'
];

function validateContatto(body, create = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Dati contatto non validi');
  }

  const data = {};

  for (const [field, value] of Object.entries(body)) {
    if (!CONTATTO_FIELDS.includes(field)) {
      throw bad(`Campo contatto non consentito: ${field}`);
    }

    if (field === 'principale') {
      if (typeof value !== 'boolean') {
        throw bad('Valore principale non valido');
      }
      data.principale = value;
      continue;
    }

    if (value !== null && typeof value !== 'string') {
      throw bad(`Valore non valido per ${field}`);
    }

    if (field === 'nome') {
      if (typeof value !== 'string' || !value.trim()) {
        throw bad('Nome referente obbligatorio');
      }
      data.nome = value.trim();
    } else {
      data[field] = value === null ? null : (value.trim() || null);
    }
  }

  if (create && !data.nome) {
    throw bad('Nome referente obbligatorio');
  }

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
    const {
      ricerca = '', stato = '', provincia = '', comune = '', telefono = '',
      prossimo_contatto = '', flotta = '', min_mezzi = '',
      min_contatti = '', max_contatti = '', ordine = 'recenti', pagina = '1', limite = '20'
    } = req.query;
    if ([ricerca, stato, provincia, comune, telefono, min_contatti, max_contatti, prossimo_contatto, flotta, min_mezzi].some(v => typeof v !== 'string')) throw bad('Filtri non validi');
    if (!['', 'presente', 'assente'].includes(telefono)) throw bad('Filtro telefono non valido');
    if ([min_contatti, max_contatti].some(v => v !== '' && (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))) ||
        (max_contatti !== '' && Number(min_contatti) > Number(max_contatti))) throw bad('Intervallo contatti non valido');
    if (!['', 'scaduto', 'oggi', 'prossimi_7_giorni', 'senza_data'].includes(prossimo_contatto)) throw bad('Filtro prossimo contatto non valido');
    if (!['', 'auto', 'van', 'bus', 'non_censita'].includes(flotta)) throw bad('Filtro flotta non valido');
    if (min_mezzi !== '' && (!parseId(min_mezzi) || flotta === 'non_censita')) throw bad('Numero minimo di mezzi non valido');
    const orders = { recenti: 'o.creato_il DESC', nome: 'lower(o.ragione_sociale) ASC', ultimo: 'ultimo_contatto_il DESC NULLS LAST', prossimo: 'o.prossimo_contatto_il ASC NULLS LAST' };
    if (!Object.hasOwn(orders, ordine) || typeof ordine !== 'string') throw bad('Ordinamento non valido');
    const page = Number(pagina), pageSize = Number(limite);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw bad('Parametri di paginazione non validi');
    const params = [], filters = ['o.archiviato_il IS NULL'];
    const contactCount = `(SELECT COUNT(*) FROM public.procaccio_attivita a
                           WHERE a.operatore_id = o.id AND a.stato = 'completata')`;
    if (ricerca.trim()) {
      params.push(`%${ricerca.trim()}%`);
      const pattern = '$' + params.length;
      const terms = [`o.ragione_sociale ILIKE ${pattern}`, `o.telefono ILIKE ${pattern}`, `o.email ILIKE ${pattern}`];
      const digits = ricerca.replace(/[^0-9]/g, '');
      if (digits && /^\+?[0-9 ().-]+$/.test(ricerca.trim())) {
        params.push(`%${digits}%`);
        terms.push(`regexp_replace(o.telefono, '[^0-9]', '', 'g') LIKE $${params.length}`);
      }
      filters.push(`(${terms.join(' OR ')})`);
    }
    if (provincia.trim()) { params.push(provincia.trim()); filters.push(`o.provincia = $${params.length}`); }
    if (comune.trim()) {
      params.push(comune.trim());
      const nomeComune = value => `lower(translate(${value},
        'ÀÁÂÄÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜàáâäèéêëìíîïòóôöùúûü’',
        'AAAAEEEEIIIIOOOOUUUUaaaaeeeeiiiioooouuuu' || chr(39)))`;
      filters.push(`strpos(${nomeComune('o.comune')}, ${nomeComune('$' + params.length)}) > 0`);
    }
    if (telefono) {
      const phone = "NULLIF(regexp_replace(o.telefono, '[[:space:]]', '', 'g'), '')";
      filters.push(telefono === 'presente' ? `${phone} IS NOT NULL` : `${phone} IS NULL`);
    }
    for (const [value, operator] of [[min_contatti, '>='], [max_contatti, '<=']]) {
      if (value === '') continue;
      params.push(Number(value));
      filters.push(`${contactCount} ${operator} $${params.length}`);
    }
    if (prossimo_contatto) {
      const giornoLocale = "(o.prossimo_contatto_il AT TIME ZONE 'Europe/Rome')::date";
      const oggi = "(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date";
      const scadenze = {
        scaduto: `${giornoLocale} < ${oggi}`,
        oggi: `${giornoLocale} = ${oggi}`,
        prossimi_7_giorni: `${giornoLocale} BETWEEN ${oggi} + 1 AND ${oggi} + 7`,
        senza_data: 'o.prossimo_contatto_il IS NULL'
      };
      filters.push(scadenze[prossimo_contatto]);
    }
    if (flotta === 'non_censita') {
      filters.push(`NOT EXISTS (SELECT 1 FROM public.procaccio_flotte mezzi
                                WHERE mezzi.operatore_id = o.id AND mezzi.quantita > 0)`);
    } else if (flotta || min_mezzi) {
      let tipo = '';
      if (flotta) {
        params.push(flotta);
        tipo = `AND lower(btrim(mezzi.tipologia)) = $${params.length}`;
      }
      params.push(min_mezzi ? Number(min_mezzi) : 1);
      filters.push(`(SELECT COALESCE(SUM(mezzi.quantita), 0) FROM public.procaccio_flotte mezzi
                     WHERE mezzi.operatore_id = o.id ${tipo}) >= $${params.length}`);
    }
    const counters = await pool.query(`
      SELECT count(*)::int AS totale,
        count(*) FILTER (WHERE o.stato = 'da_contattare')::int AS da_contattare,
        count(*) FILTER (WHERE o.stato = 'in_trattativa')::int AS in_trattativa,
        count(*) FILTER (WHERE o.stato = 'aderito')::int AS aderito
      FROM public.procaccio_operatori o WHERE ${filters.join(' AND ')}
    `, params);
    if (stato.trim()) { params.push(stato.trim()); filters.push('o.stato = ' + String.fromCharCode(36) + params.length); }
    const where = `WHERE ${filters.join(' AND ')}`;
    const count = stato.trim() ? await pool.query(`SELECT COUNT(*)::int AS totale FROM public.procaccio_operatori o ${where}`, params) : counters;
    const data = await pool.query(
      `SELECT o.*, p.nome AS procacciatore_nome, p.cognome AS procacciatore_cognome,
              COALESCE(f.totale_mezzi, 0)::int AS totale_mezzi,
              ${contactCount}::int AS totale_contatti,
              (SELECT max(coalesce(a.completata_il, a.creato_il)) FROM public.procaccio_attivita a WHERE a.operatore_id = o.id AND a.stato = 'completata') AS ultimo_contatto_il
       FROM public.procaccio_operatori o
       LEFT JOIN public.procaccio_procacciatori p ON p.id = o.procacciatore_id
       LEFT JOIN (SELECT operatore_id, SUM(quantita) AS totale_mezzi FROM public.procaccio_flotte GROUP BY operatore_id) f ON f.operatore_id = o.id
       ${where} ORDER BY ${orders[ordine]}, o.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const totale = count.rows[0].totale;
    const totaleRegistrati = filters.length === 1 ? totale : (await pool.query(
      'SELECT COUNT(*)::int AS totale FROM public.procaccio_operatori WHERE archiviato_il IS NULL'
    )).rows[0].totale;
    return res.json({ operatori: data.rows, totale, totale_registrati: totaleRegistrati, contatori_stato: counters.rows[0], pagina: page, limite: pageSize });
  } catch (err) { return respondError(err, res); }
});


const callOutcomes = new Map([
  ['risposto', ['Ha risposto', 'contattato']],
  ['interessato', ['Interessato', 'interessato']],
  ['richiamare', ['Da richiamare', 'contattato']],
  ['nessuna_risposta', ['Nessuna risposta', 'non_raggiungibile']],
  ['non_interessato', ['Non interessato', 'non_interessato']],
]);

router.post('/operatori/:id/telefonate', async (req, res) => {
  const id = parseId(req.params.id);
  const { esito, note = '', aggiorna_stato = false } = req.body ?? {};
  const outcome = callOutcomes.get(esito);
  if (!id || !outcome || typeof note !== 'string' || note.length > 1000 || typeof aggiorna_stato !== 'boolean') {
    return res.status(400).json({ error: 'Dati telefonata non validi' });
  }
  try {
    const activity = await withTransaction(async client => {
      const { rows: [operator] } = await client.query(
        'SELECT stato, procacciatore_id FROM public.procaccio_operatori WHERE id = $1 AND archiviato_il IS NULL FOR UPDATE', [id]
      );
      if (!operator) return null;
      const { rows: [call] } = await client.query(`
        INSERT INTO public.procaccio_attivita
          (operatore_id, procacciatore_id, tipo, stato, titolo, descrizione, completata_il, esito)
        VALUES ($1, $2, 'telefonata', 'completata', 'Telefonata', $3, now(), $4)
        RETURNING *
      `, [id, operator.procacciatore_id, note.trim() || null, outcome[0]]);
      if (aggiorna_stato && operator.stato !== outcome[1]) {
        await client.query('UPDATE public.procaccio_operatori SET stato = $2, aggiornato_il = now() WHERE id = $1', [id, outcome[1]]);
      }
      await history(client, id, 'registrazione_telefonata', req, {
        attivita_id: call.id, esito, stato_precedente: operator.stato,
        stato_nuovo: aggiorna_stato ? outcome[1] : operator.stato,
      });
      return call;
    });
    if (!activity) return res.status(404).json({ error: 'Operatore non trovato o archiviato' });
    return res.status(201).json({ attivita: activity });
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
      `SELECT o.*, p.nome AS procacciatore_nome, p.cognome AS procacciatore_cognome,
         (SELECT max(coalesce(a.completata_il, a.creato_il)) FROM public.procaccio_attivita a WHERE a.operatore_id = o.id AND a.stato = 'completata') AS ultimo_contatto_il
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

// PUT /api/admin/procaccio/operatori/:id/flotta
// Aggiornamento atomico delle quantità Auto / Bus / Van
router.put('/operatori/:id/flotta', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID operatore non valido' });
  }

  try {
    const body = req.body;
    const tipi = ['Auto', 'Bus', 'Van'];

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw bad('Dati flotta non validi');
    }

    if (
      Object.keys(body).length !== 3 ||
      !tipi.every(tipo => Object.prototype.hasOwnProperty.call(body, tipo))
    ) {
      throw bad('Sono richieste le quantità Auto, Bus e Van');
    }

    for (const tipo of tipi) {
      const quantita = body[tipo];
      if (
        !Number.isSafeInteger(quantita) ||
        quantita < 0 ||
        quantita > 9999
      ) {
        throw bad(`Quantità non valida per ${tipo}`);
      }
    }

    const result = await withTransaction(async client => {
      const operatore = await client.query(
        `SELECT id
         FROM public.procaccio_operatori
         WHERE id = $1 AND archiviato_il IS NULL
         FOR UPDATE`,
        [id]
      );

      if (!operatore.rowCount) return null;

      const precedenti = await client.query(
        `SELECT *
         FROM public.procaccio_flotte
         WHERE operatore_id = $1
         FOR UPDATE`,
        [id]
      );

      const sconosciute = precedenti.rows.filter(
        item => !tipi.includes(item.tipologia)
      );

      if (sconosciute.length) {
        throw bad(
          'Sono presenti tipologie da riclassificare prima del salvataggio'
        );
      }

      const modifiche = [];

      for (const tipo of tipi) {
        const quantita = body[tipo];
        const precedente = precedenti.rows.find(
          item => item.tipologia === tipo
        );

        if (precedente) {
          if (precedente.quantita !== quantita) {
            await client.query(
              `UPDATE public.procaccio_flotte
               SET quantita = $1, aggiornato_il = NOW()
               WHERE id = $2 AND operatore_id = $3`,
              [quantita, precedente.id, id]
            );

            modifiche.push({
              tipologia: tipo,
              precedente: precedente.quantita,
              nuovo: quantita
            });
          }
        } else if (quantita > 0) {
          await client.query(
            `INSERT INTO public.procaccio_flotte
             (operatore_id, tipologia, quantita, note)
             VALUES ($1, $2, $3, NULL)`,
            [id, tipo, quantita]
          );

          modifiche.push({
            tipologia: tipo,
            precedente: 0,
            nuovo: quantita
          });
        }
      }

      if (modifiche.length) {
        await history(
          client,
          id,
          'aggiornamento_flotta_contatori',
          req,
          { modifiche }
        );
      }

      const finale = await client.query(
        `SELECT *
         FROM public.procaccio_flotte
         WHERE operatore_id = $1
         ORDER BY tipologia`,
        [id]
      );

      return {
        flotta: finale.rows,
        modificato: modifiche.length > 0,
        modifiche
      };
    });

    if (!result) {
      return res.status(404).json({
        error: 'Operatore non trovato o archiviato'
      });
    }

    return res.json(result);
  } catch (err) {
    return respondError(err, res);
  }
});

// POST /api/admin/procaccio/operatori/:id/flotte
router.post('/operatori/:id/flotte', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID operatore non valido' });
  try {
    const data = validateFlotta(req.body, true);
    const flotta = await withTransaction(async client => {
      const operatore = await client.query(
        'SELECT id FROM public.procaccio_operatori WHERE id = $1 AND archiviato_il IS NULL FOR UPDATE', [id]
      );
      if (!operatore.rowCount) return null;
      const result = await client.query(
        `INSERT INTO public.procaccio_flotte (operatore_id, tipologia, quantita, note)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, data.tipologia, data.quantita ?? 0, data.note ?? null]
      );
      await history(client, id, 'creazione_flotta', req, { flotta: result.rows[0] });
      return result.rows[0];
    });
    if (!flotta) return res.status(404).json({ error: 'Operatore non trovato o archiviato' });
    return res.status(201).json({ flotta });
  } catch (err) { return respondError(err, res); }
});

// PATCH /api/admin/procaccio/operatori/:id/flotte/:flottaId
router.patch('/operatori/:id/flotte/:flottaId', async (req, res) => {
  const id = parseId(req.params.id), flottaId = parseId(req.params.flottaId);
  if (!id || !flottaId) return res.status(400).json({ error: 'ID non valido' });
  try {
    const data = validateFlotta(req.body);
    const fields = Object.keys(data);
    if (!fields.length) throw bad('Nessun campo da aggiornare');
    const result = await withTransaction(async client => {
      const operatore = await client.query(
        'SELECT id FROM public.procaccio_operatori WHERE id = $1 AND archiviato_il IS NULL FOR UPDATE', [id]
      );
      if (!operatore.rowCount) return null;
      const previous = await client.query(
        'SELECT * FROM public.procaccio_flotte WHERE id = $1 AND operatore_id = $2 FOR UPDATE',
        [flottaId, id]
      );
      if (!previous.rowCount) return null;
      const modifiche = {};
      for (const field of fields) {
        if (previous.rows[0][field] !== data[field]) {
          modifiche[field] = { precedente: previous.rows[0][field], nuovo: data[field] };
        }
      }
      if (!Object.keys(modifiche).length) return { flotta: previous.rows[0], modificato: false };
      const updated = await client.query(
        `UPDATE public.procaccio_flotte SET ${fields.map((field, i) => `${field} = $${i + 1}`).join(', ')},
         aggiornato_il = NOW() WHERE id = $${fields.length + 1} AND operatore_id = $${fields.length + 2} RETURNING *`,
        [...Object.values(data), flottaId, id]
      );
      await history(client, id, 'aggiornamento_flotta', req, { flotta_id: flottaId, modifiche });
      return { flotta: updated.rows[0], modificato: true };
    });
    if (!result) return res.status(404).json({ error: 'Operatore o voce flotta non trovati, oppure operatore archiviato' });
    return res.json(result);
  } catch (err) { return respondError(err, res); }
});

// DELETE /api/admin/procaccio/operatori/:id/flotte/:flottaId
router.delete('/operatori/:id/flotte/:flottaId', async (req, res) => {
  const id = parseId(req.params.id), flottaId = parseId(req.params.flottaId);
  if (!id || !flottaId) return res.status(400).json({ error: 'ID non valido' });
  try {
    const deleted = await withTransaction(async client => {
      const operatore = await client.query(
        'SELECT id FROM public.procaccio_operatori WHERE id = $1 AND archiviato_il IS NULL FOR UPDATE', [id]
      );
      if (!operatore.rowCount) return null;
      const result = await client.query(
        'DELETE FROM public.procaccio_flotte WHERE id = $1 AND operatore_id = $2 RETURNING *',
        [flottaId, id]
      );
      if (!result.rowCount) return null;
      await history(client, id, 'eliminazione_flotta', req, { flotta: result.rows[0] });
      return result.rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Operatore o voce flotta non trovati, oppure operatore archiviato' });
    return res.json({ eliminata: true, flotta: deleted });
  } catch (err) { return respondError(err, res); }
});

 // POST /api/admin/procaccio/operatori/:id/contatti
router.post('/operatori/:id/contatti', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({
      error: 'ID operatore non valido'
    });
  }

  try {
    const data = validateContatto(req.body, true);

    const result = await withTransaction(async client => {
      const operatore = await client.query(
        `SELECT id FROM public.procaccio_operatori
         WHERE id = $1 AND archiviato_il IS NULL
         FOR UPDATE`,
        [id]
      );

      if (!operatore.rowCount) return null;

      let precedentePrincipale = null;

      if (data.principale === true) {
        const precedente = await client.query(
          `UPDATE public.procaccio_contatti
           SET principale = FALSE
           WHERE operatore_id = $1 AND principale = TRUE
           RETURNING id`,
          [id]
        );
        precedentePrincipale = precedente.rows[0]?.id ?? null;
      }

      const inserted = await client.query(
        `INSERT INTO public.procaccio_contatti
         (operatore_id, nome, cognome, ruolo,
          telefono, email, principale, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          id,
          data.nome,
          data.cognome ?? null,
          data.ruolo ?? null,
          data.telefono ?? null,
          data.email ?? null,
          data.principale ?? false,
          data.note ?? null
        ]
      );

      const contatto = inserted.rows[0];

      await history(
        client,
        id,
        'creazione_contatto',
        req,
       {
  contatto,
  precedente_principale_id: precedentePrincipale,
  sostituzione_principale: precedentePrincipale !== null
    ? {
        contatto_id: precedentePrincipale,
        principale_precedente: true,
        principale_nuovo: false
      }
    : null
}
      );

      return contatto;
    });

    if (!result) {
      return res.status(404).json({
        error: 'Operatore non trovato o archiviato'
      });
    }

    return res.status(201).json({ contatto: result });

  } catch (err) {
    return respondError(err, res);
  }
});

 // PATCH /api/admin/procaccio/operatori/:id/contatti/:contattoId
router.patch('/operatori/:id/contatti/:contattoId', async (req, res) => {
  const id = parseId(req.params.id);
  const contattoId = parseId(req.params.contattoId);

  if (!id || !contattoId) {
    return res.status(400).json({ error: 'ID non valido' });
  }

  try {
    const data = validateContatto(req.body);
    const fields = Object.keys(data);

    if (!fields.length) {
      throw bad('Nessun campo da aggiornare');
    }

    const result = await withTransaction(async client => {
      const operatore = await client.query(
        `SELECT id FROM public.procaccio_operatori
         WHERE id = $1 AND archiviato_il IS NULL
         FOR UPDATE`,
        [id]
      );

      if (!operatore.rowCount) return null;

      const previous = await client.query(
        `SELECT * FROM public.procaccio_contatti
         WHERE id = $1 AND operatore_id = $2
         FOR UPDATE`,
        [contattoId, id]
      );

      if (!previous.rowCount) return null;

      const precedente = previous.rows[0];
      const modifiche = {};

      for (const field of fields) {
        if (precedente[field] !== data[field]) {
          modifiche[field] = {
            precedente: precedente[field],
            nuovo: data[field]
          };
        }
      }

      if (!Object.keys(modifiche).length) {
        return {
          contatto: precedente,
          modificato: false
        };
      }

      let precedentePrincipale = null;

      if (data.principale === true && !precedente.principale) {
        const oldPrincipal = await client.query(
          `UPDATE public.procaccio_contatti
           SET principale = FALSE
           WHERE operatore_id = $1
             AND principale = TRUE
             AND id <> $2
           RETURNING id`,
          [id, contattoId]
        );

        precedentePrincipale = oldPrincipal.rows[0]?.id ?? null;
      if (precedentePrincipale !== null) {
  modifiche.referente_principale_precedente = {
    contatto_id: precedentePrincipale,
    principale_precedente: true,
    principale_nuovo: false
  };
}}


      const updated = await client.query(
        `UPDATE public.procaccio_contatti
         SET ${fields.map((field, i) =>
           `${field} = $${i + 1}`
         ).join(', ')}
         WHERE id = $${fields.length + 1}
           AND operatore_id = $${fields.length + 2}
         RETURNING *`,
        [...Object.values(data), contattoId, id]
      );

      await history(
        client,
        id,
        'aggiornamento_contatto',
        req,
        {
          contatto_id: contattoId,
          modifiche,
          precedente_principale_id: precedentePrincipale
        }
      );

      return {
        contatto: updated.rows[0],
        modificato: true
      };
    });

    if (!result) {
      return res.status(404).json({
        error: 'Operatore o referente non trovato, oppure operatore archiviato'
      });
    }

    return res.json(result);

  } catch (err) {
    return respondError(err, res);
  }
});

 // DELETE /api/admin/procaccio/operatori/:id/contatti/:contattoId
router.delete('/operatori/:id/contatti/:contattoId', async (req, res) => {
  const id = parseId(req.params.id);
  const contattoId = parseId(req.params.contattoId);

  if (!id || !contattoId) {
    return res.status(400).json({ error: 'ID non valido' });
  }

  try {
    const deleted = await withTransaction(async client => {
      const operatore = await client.query(
        `SELECT id FROM public.procaccio_operatori
         WHERE id = $1 AND archiviato_il IS NULL
         FOR UPDATE`,
        [id]
      );

      if (!operatore.rowCount) return null;

      const result = await client.query(
        `DELETE FROM public.procaccio_contatti
         WHERE id = $1 AND operatore_id = $2
         RETURNING *`,
        [contattoId, id]
      );

      if (!result.rowCount) return null;

      await history(
        client,
        id,
        'eliminazione_contatto',
        req,
        { contatto: result.rows[0] }
      );

      return result.rows[0];
    });

    if (!deleted) {
      return res.status(404).json({
        error: 'Operatore o referente non trovato, oppure operatore archiviato'
      });
    }

    return res.json({
      eliminato: true,
      contatto: deleted
    });

  } catch (err) {
    return respondError(err, res);
  }
});

export default router;
