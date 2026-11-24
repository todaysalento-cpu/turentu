import { publishManualEventImage } from '../../services/eventi/event-image-manual.service.js';
import express from 'express';
import { pool } from '../../db/db.js';

import {
  listMissingEventImages,
  groupMissingEventImages
} from '../../services/eventi/event-image-discovery.service.js';

import {
  approveEventImage,
  publishEventImage
} from '../../services/eventi/event-image-publication.service.js';

import {
  downloadCandidateImage
} from '../../services/eventi/event-image-download.service.js';

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error('[EVENT IMAGES]', error.message);

      res.status(500).json({
        success: false,
        error: 'Operazione non riuscita'
      });
    }
  };
}

function validId(value) {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

// ======================================================
// STATISTICHE
// ======================================================

router.get('/stats', handle(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM public.eventi_senza_copertina)::int
        AS senza_copertina,

      (SELECT COUNT(*) FROM public.event_image_candidates
        WHERE stato = 'pending')::int AS pending,

      (SELECT COUNT(*) FROM public.event_image_candidates
        WHERE stato = 'approved')::int AS approved,

      (SELECT COUNT(*) FROM public.event_image_candidates
        WHERE stato = 'published')::int AS published,

      (SELECT COUNT(*) FROM public.event_image_candidates
        WHERE stato = 'rejected')::int AS rejected,

      (SELECT COUNT(*) FROM public.event_image_assets)::int
        AS assets,

      (SELECT COALESCE(SUM(bytes),0)
        FROM public.event_image_assets) AS bytes_totali
  `);

  res.json({
    success: true,
    stats: rows[0]
  });
}));

// ======================================================
// EVENTI SENZA COPERTINA
// ======================================================

router.get('/missing', handle(async (req, res) => {
  const events = await listMissingEventImages();

  res.json({
    success: true,
    totale: events.length,
    eventi: events
  });
}));

// ======================================================
// RAGGRUPPAMENTO PER SPETTACOLO
// ======================================================

router.get('/groups', handle(async (req, res) => {
  const groups = await groupMissingEventImages();

  res.json({
    success: true,
    totale: groups.length,
    gruppi: groups
  });
}));

// ======================================================
// IMMAGINI CANDIDATE
// ======================================================

router.get('/candidates', handle(async (req, res) => {
  const stato = req.query.stato || null;

  const allowed = [
    'pending',
    'approved',
    'rejected',
    'published',
    'error'
  ];

  if (stato && !allowed.includes(stato)) {
    return res.status(400).json({
      success: false,
      error: 'Stato non valido'
    });
  }

  const { rows } = await pool.query(`
    SELECT
      c.*,
      e.titolo AS evento_titolo,
      e.citta,
      e.categoria,
      e.data_inizio,
      e.luogo_nome,
      e.immagine_url AS copertina_attuale,
      s.nome AS fonte_nome,
      s.download_abilitato,
      a.immagine_url AS asset_url
    FROM public.event_image_candidates c
    JOIN public.eventi e
      ON e.id = c.evento_id
    LEFT JOIN public.event_image_sources s
      ON s.id = c.source_id
    LEFT JOIN public.event_image_assets a
      ON a.id = c.asset_id
    WHERE ($1::text IS NULL OR c.stato = $1)
    ORDER BY c.created_at DESC
    LIMIT 500
  `, [stato]);

  res.json({
    success: true,
    candidate: rows
  });
}));

// ======================================================
// ELENCO FONTI
// ======================================================

router.get('/sources', handle(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT *
    FROM public.event_image_sources
    ORDER BY nome
  `);

  res.json({
    success: true,
    fonti: rows
  });
}));

// ======================================================
// CONFIGURAZIONE FONTI
// ======================================================

router.patch('/sources/:id', handle(async (req, res) => {
  const id = validId(req.params.id);

  if (!id) {
    return res.status(400).json({
      success: false,
      error: 'ID fonte non valido'
    });
  }

  const {
    ricerca_abilitata,
    download_abilitato,
    pubblicazione_automatica,
    condizioni_utilizzo,
    licenza,
    diritti_verificati
  } = req.body || {};

  if (
    typeof ricerca_abilitata !== 'boolean' ||
    typeof download_abilitato !== 'boolean' ||
    typeof pubblicazione_automatica !== 'boolean'
  ) {
    return res.status(400).json({
      success: false,
      error: 'Configurazione non valida'
    });
  }

  if (
    condizioni_utilizzo != null &&
    typeof condizioni_utilizzo !== 'string'
  ) {
    return res.status(400).json({
      success: false,
      error: 'Condizioni di utilizzo non valide'
    });
  }

  if (
    licenza != null &&
    typeof licenza !== 'string'
  ) {
    return res.status(400).json({
      success: false,
      error: 'Licenza non valida'
    });
  }

  if (
    diritti_verificati != null &&
    typeof diritti_verificati !== 'boolean'
  ) {
    return res.status(400).json({
      success: false,
      error: 'Verifica diritti non valida'
    });
  }

  if (
    ricerca_abilitata &&
    !condizioni_utilizzo?.trim()
  ) {
    return res.status(400).json({
      success: false,
      error: 'Condizioni di utilizzo obbligatorie'
    });
  }

  if (
    diritti_verificati === true &&
    !licenza?.trim()
  ) {
    return res.status(400).json({
      success: false,
      error: 'Licenza obbligatoria per verificare i diritti'
    });
  }

  if (
    download_abilitato &&
    (
      diritti_verificati !== true ||
      !licenza?.trim()
    )
  ) {
    return res.status(400).json({
      success: false,
      error: 'Licenza e verifica dei diritti obbligatorie'
    });
  }

  // Pubblicazione automatica non ancora disponibile.

  if (pubblicazione_automatica) {
    return res.status(409).json({
      success: false,
      error: 'Pubblicazione automatica non ancora disponibile'
    });
  }

  // Blocco temporaneo dell'acquisizione remota.

  if (ricerca_abilitata || download_abilitato) {
    return res.status(409).json({
      success: false,
      error: 'Acquisizione remota non ancora disponibile'
    });
  }

  const { rows } = await pool.query(`
    UPDATE public.event_image_sources
    SET
      ricerca_abilitata = $2,
      download_abilitato = $3,
      pubblicazione_automatica = $4,
      condizioni_utilizzo = $5,
      licenza = $6,
      verificato_il = CASE
        WHEN $7::boolean THEN NOW()
        ELSE NULL
      END
    WHERE id = $1
    RETURNING *
  `, [
    id,
    ricerca_abilitata,
    download_abilitato,
    pubblicazione_automatica,
    condizioni_utilizzo?.trim() || null,
    licenza?.trim() || null,
    diritti_verificati === true
  ]);

  if (!rows.length) {
    return res.status(404).json({
      success: false,
      error: 'Fonte non trovata'
    });
  }

  res.json({
    success: true,
    fonte: rows[0]
  });
}));

// ======================================================
// APPROVAZIONE CANDIDATA
// ======================================================

router.post('/:id/approve', handle(async (req, res) => {
  const id = validId(req.params.id);

  const {
    licenza,
    attribuzione,
    diritti_verificati
  } = req.body || {};

  if (
    !id ||
    diritti_verificati !== true ||
    typeof licenza !== 'string' ||
    !licenza.trim()
  ) {
    return res.status(400).json({
      success: false,
      error: 'Conferma dei diritti e licenza obbligatorie'
    });
  }

  if (
    attribuzione != null &&
    typeof attribuzione !== 'string'
  ) {
    return res.status(400).json({
      success: false,
      error: 'Attribuzione non valida'
    });
  }

  const candidate = await approveEventImage(id, {
    licenza: licenza.trim(),
    attribuzione: attribuzione?.trim() || null
  });

  res.json({
    success: true,
    candidate
  });
}));

// ======================================================
// RIFIUTO CANDIDATA
// ======================================================

router.post('/:id/reject', handle(async (req, res) => {
  const id = validId(req.params.id);

  if (!id) {
    return res.status(400).json({
      success: false,
      error: 'ID non valido'
    });
  }

  const { rows } = await pool.query(`
    UPDATE public.event_image_candidates
    SET
      stato = 'rejected',
      reviewed_at = NOW()
    WHERE id = $1
      AND stato IN ('pending', 'approved')
    RETURNING *
  `, [id]);

  if (!rows.length) {
    return res.status(409).json({
      success: false,
      error: 'Candidata non rifiutabile'
    });
  }

  res.json({
    success: true,
    candidate: rows[0]
  });
}));

// ======================================================
// DOWNLOAD E PUBBLICAZIONE
// ======================================================

router.post('/:id/publish', handle(async (req, res) => {
  const id = validId(req.params.id);

  if (!id) {
    return res.status(400).json({
      success: false,
      error: 'ID non valido'
    });
  }

  // Blocco temporaneo fino al completamento
  // dei controlli di sicurezza del download.

  if (
    process.env.EVENT_IMAGE_REMOTE_PUBLISH_ENABLED
      !== 'true'
  ) {
    return res.status(403).json({
      success: false,
      error: 'Pubblicazione remota disabilitata'
    });
  }

  const buffer = await downloadCandidateImage(id);

  const result = await publishEventImage(
    id,
    buffer
  );

  res.json({
    success: true,
    result
  });
}));

router.post('/manual', async (req, res) => {
  try {
    const result = await publishManualEventImage(req.body || {});
    res.json({ success: true, result });
  } catch (error) {
    console.error('[EVENT IMAGE MANUAL]', error.message);
    const status = [400,404,409,413].includes(error.status) ? error.status : 500;
    res.status(status).json({ success: false, error: status === 500 ? 'Caricamento immagine non riuscito' : error.message });
  }
});

export default router;