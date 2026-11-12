import express from 'express';
import { pool } from '../../db/db.js';
import { vehicleChecks, vehicleOverview, vehicleOverviewJoins } from './vehicle-overview.js';
import { cloudinary } from '../../services/cloudinary.js';
import { parseCloudinaryUrl } from '../../services/auth/account-removals.service.js';

const router = express.Router();
const accountFields = 'u.id, u.nome, u.email, u.phone, u.tipo, u.created_at, u.modalita_operativa, u.email_verificata_il';
const configuration = `
  vehicle_configuration AS (
    SELECT v.id, v.driver_id, ${vehicleChecks} FROM veicolo v
  ),
  fleet AS (
    SELECT driver_id, count(*)::int AS veicoli,
      bool_and(tariffa_standard AND disponibilita_configurata) AS veicoli_completi
    FROM vehicle_configuration GROUP BY driver_id
  )
`;
const complete = `(coalesce(u.modalita_operativa IN ('singolo', 'flotta'), false)
  AND EXISTS (SELECT 1 FROM autista_profilo ap WHERE ap.utente_id = u.id)
  AND coalesce(f.veicoli_completi, false))`;
const operatorUpdatedAt = user => `greatest(
  (SELECT max(coalesce(p.updated_at, p.created_at))::timestamptz
    FROM autista_profilo p WHERE p.utente_id = ${user}.id),
  (SELECT max(v.created_at)::timestamptz FROM veicolo v WHERE v.driver_id = ${user}.id),
  (SELECT max(coalesce(t.updated_at, t.created_at))::timestamptz
    FROM tariffe t JOIN veicolo v ON v.id = t.veicolo_id WHERE v.driver_id = ${user}.id),
  (SELECT max(d.created_at)::timestamptz FROM documenti_autista d WHERE d.autista_id = ${user}.id),
  (SELECT max(c.aggiornato_il) FROM conducenti_operatori c WHERE c.operatore_id = ${user}.id)
)`;
const validId = value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 2147483647;

function adminRead(handler) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await handler(req, res);
    } catch (error) {
      console.error('Lettura gestione utenti:', error.code || error.name);
      res.status(500).json({ error: 'Impossibile caricare la gestione utenti' });
    }
  };
}

async function isCurrentAdmin(id) {
  const { rowCount } = await pool.query(`
    SELECT 1 FROM utente WHERE id = $1 AND eliminato_il IS NULL AND lower(btrim(tipo)) = 'admin'
  `, [id]);
  return rowCount > 0;
}

router.get('/utenti/contatori', adminRead(async (_req, res) => {
  const { rows: [result] } = await pool.query(`
    WITH ${configuration}, local_clock AS (
      SELECT now() AT TIME ZONE 'Europe/Rome' AS local_now
    ), bounds AS (
      SELECT date_trunc('day', local_now) AT TIME ZONE 'Europe/Rome' AS oggi,
        (date_trunc('day', local_now) - interval '6 days') AT TIME ZONE 'Europe/Rome' AS sette_giorni,
        date_trunc('week', local_now) AT TIME ZONE 'Europe/Rome' AS settimana
      FROM local_clock
    )
    SELECT count(*)::int AS totale,
      count(*) FILTER (WHERE lower(btrim(u.tipo)) = 'cliente')::int AS clienti,
      count(*) FILTER (WHERE lower(btrim(u.tipo)) = 'autista')::int AS operatori,
      count(*) FILTER (WHERE u.created_at BETWEEN b.oggi AND now())::int AS oggi,
      count(*) FILTER (WHERE u.created_at BETWEEN b.sette_giorni AND now())::int AS ultimi_sette,
      count(*) FILTER (WHERE u.created_at BETWEEN b.settimana AND now())::int AS settimana,
      count(*) FILTER (WHERE lower(btrim(u.tipo)) = 'autista' AND NOT ${complete})::int AS incompleti
    FROM utente u CROSS JOIN bounds b LEFT JOIN fleet f ON f.driver_id = u.id WHERE u.eliminato_il IS NULL
  `);
  res.json(result);
}));

router.get('/utenti', adminRead(async (req, res) => {
  const { ruolo, q = '', modalita = '', configurazione = '' } = req.query;
  const page = Number(req.query.page ?? 1);
  const limit = 25;
  if (!['cliente', 'autista'].includes(ruolo) || typeof q !== 'string' || q.length > 100 ||
      !['', 'singolo', 'flotta', 'non_definita'].includes(modalita) ||
      !['', 'completa', 'incompleta'].includes(configurazione) ||
      !Number.isSafeInteger(page) || page < 1 || page > 1000000) {
    return res.status(400).json({ error: 'Parametri di ricerca non validi' });
  }

  const driver = ruolo === 'autista';
  const { rows } = await pool.query(`
    ${driver ? `WITH ${configuration}, candidates AS (` : 'WITH candidates AS ('}
      SELECT ${accountFields}
        ${driver ? `, coalesce(f.veicoli, 0) AS veicoli, ${complete} AS completa` : ''}
      FROM utente u ${driver ? 'LEFT JOIN fleet f ON f.driver_id = u.id' : ''}
      WHERE u.eliminato_il IS NULL AND lower(btrim(u.tipo)) = $1
        AND ($2 = '' OR strpos(lower(u.nome), lower($2)) > 0
          OR strpos(lower(u.email), lower($2)) > 0 OR strpos(u.phone, $2) > 0
          OR u.id::text = $2
          ${driver ? `OR EXISTS (
            SELECT 1 FROM autista_profilo p WHERE p.utente_id = u.id
              AND (strpos(lower(concat_ws(' ', p.nome, p.cognome)), lower($2)) > 0
                OR strpos(p.telefono, $2) > 0)
          )` : ''})
    ), page AS (
      SELECT * FROM candidates
      ${driver ? `WHERE ($5 = '' OR coalesce(modalita_operativa, 'non_definita') = $5)
        AND ($6 = '' OR completa = ($6 = 'completa'))` : ''}
      ORDER BY created_at DESC NULLS LAST, id DESC LIMIT $3 OFFSET $4
    )
    SELECT page.* ${driver ? ', ' + operatorUpdatedAt('page') + ' AS ultimo_aggiornamento' : `, (
      SELECT count(*)::int FROM prenotazioni p WHERE p.cliente_id = page.id
    ) AS prenotazioni`}
    FROM page ORDER BY created_at DESC NULLS LAST, id DESC
  `, [ruolo, q.trim(), limit + 1, (page - 1) * limit, ...(driver ? [modalita, configurazione] : [])]);
  res.json({ items: rows.slice(0, limit), page, hasMore: rows.length > limit });
}));

router.get('/utenti/:id/documenti/:documentId', adminRead(async (req, res) => {
  const { id, documentId } = req.params;
  if (![id, documentId].every(validId)) return res.status(400).json({ error: 'ID non valido' });

  if (!await isCurrentAdmin(req.user.id)) return res.status(403).json({ error: 'Permesso amministrativo non valido' });

  const { rows: [document] } = await pool.query(`
    SELECT d.url FROM documenti_autista d
    JOIN utente u ON u.id = d.autista_id
    WHERE d.id = $1 AND u.id = $2 AND u.eliminato_il IS NULL AND lower(btrim(u.tipo)) = 'autista'
      AND (d.veicolo_id IS NULL OR EXISTS (
        SELECT 1 FROM veicolo v WHERE v.id = d.veicolo_id AND v.driver_id = u.id
      ))
  `, [Number(documentId), Number(id)]);
  if (!document?.url?.trim()) return res.status(404).json({ error: 'Documento non trovato' });

  let url;
  try {
    url = new URL(document.url);
  } catch {
    return res.status(422).json({ error: 'Indirizzo del documento non valido' });
  }
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || url.protocol !== 'https:' || url.host !== 'res.cloudinary.com' ||
      url.username || url.password || !url.pathname.startsWith('/' + cloud + '/')) {
    return res.status(422).json({ error: 'Archivio del documento non riconosciuto' });
  }
  if (/\.(gif|jpe?g|png|webp)$/i.test(url.pathname)) {
    return res.json({ url: url.href, immagine: true, anteprime: [url.href] });
  }

  const resource = parseCloudinaryUrl(url.href, cloud);
  if (resource?.resourceType !== 'image') {
    return res.status(422).json({ error: 'Formato del documento non supportato per l’anteprima' });
  }

  const pdf = /\.pdf$/i.test(url.pathname);
  let pages = 1;
  let complete = !pdf;
  if (pdf) {
    try {
      const metadata = await cloudinary.api.resource(resource.publicId, {
        resource_type: 'image', type: 'upload', pages: true, timeout: 8000,
      });
      if (Number.isSafeInteger(metadata.pages) && metadata.pages > 0) {
        pages = metadata.pages;
        complete = true;
      }
    } catch (error) {
      console.warn('Conteggio pagine documento non disponibile:', error.http_code || error.name);
    }
  }
  const version = url.pathname.match(/\/v(\d+)\//)?.[1];
  const previews = Array.from({ length: pages }, (_, index) => cloudinary.url(resource.publicId, {
    secure: true, sign_url: Boolean(process.env.CLOUDINARY_API_SECRET), version,
    resource_type: 'image', format: 'jpg', width: 1800, crop: 'limit',
    ...(pdf ? { page: index + 1 } : {}),
  }));
  res.json({ url: previews[0], immagine: true, anteprime: previews, pagine_complete: complete });
}));

router.get('/utenti/:id', adminRead(async (req, res) => {
  const id = Number(req.params.id);
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: 'ID utente non valido' });
  }

  const { rows: [utente] } = await pool.query(`
    SELECT ${accountFields}, (SELECT count(*)::int FROM prenotazioni WHERE cliente_id = u.id) AS prenotazioni,
      CASE WHEN lower(btrim(u.tipo)) = 'autista' THEN ${operatorUpdatedAt('u')} END AS ultimo_aggiornamento
    FROM utente u WHERE u.eliminato_il IS NULL AND u.id = $1 AND lower(btrim(u.tipo)) IN ('cliente', 'autista')
  `, [id]);
  if (!utente) return res.status(404).json({ error: 'Utente non trovato' });
  if (utente.tipo.trim().toLowerCase() === 'cliente') return res.json({ utente });

  if (!await isCurrentAdmin(req.user.id)) {
    return res.status(403).json({ error: 'Permesso amministrativo non valido' });
  }
  const [profilo, veicoli, documenti, conducenti] = await Promise.all([
    pool.query(`
      SELECT nome, cognome, telefono, iban, nome_banca, nome_titolare_conto
      FROM autista_profilo WHERE utente_id = $1 ORDER BY id DESC LIMIT 1
    `, [id]),
    pool.query(`
      SELECT v.id, v.marca, v.modello, v.targa, v.stato, v.stato_verifica, v.localita,
        ${vehicleChecks}, ${vehicleOverview}
      FROM veicolo v ${vehicleOverviewJoins} WHERE v.driver_id = $1 ORDER BY v.id
    `, [id]),
    pool.query(`
      SELECT id, tipo, veicolo_id, stato, created_at, coalesce(btrim(url) <> '', false) AS caricato
      FROM documenti_autista WHERE autista_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC
    `, [id]),
    pool.query(`
      SELECT co.id, u.nome, co.stato, co.conducente_id FROM conducenti_operatori co
      JOIN utente u ON u.id = co.conducente_id WHERE co.operatore_id = $1
      ORDER BY u.nome, co.id
    `, [id])
  ]);
  res.json({ utente, profilo: profilo.rows[0] ?? null, veicoli: veicoli.rows,
    documenti: documenti.rows, conducenti: conducenti.rows });
}));

export default router;
