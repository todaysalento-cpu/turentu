
import { createHash } from 'node:crypto';
import { pool } from '../../db/db.js';

function assert(ok, message) {
  if (!ok) throw new Error(`PIXEL_PERSISTENCE: ${message}`);
}

const validId = n =>
  Number.isSafeInteger(Number(n)) && Number(n) > 0;

const json = value => JSON.stringify(value);

const digest = value =>
  createHash('sha256').update(json(value)).digest('hex');

const toDate = ms => {
  assert(Number.isFinite(ms), 'timestamp non valido');
  const d = new Date(ms);
  assert(!Number.isNaN(d.getTime()), 'data non valida');
  return d;
};

function normalizeCorridor(c) {
  assert(
    c && c.verificataRouting === true,
    'routing direttrice non verificato'
  );

  assert(
    Array.isArray(c.nodes) && c.nodes.length >= 2,
    'sequenza nodi non valida'
  );

  const nodes = c.nodes.map(Number);

  assert(
    nodes.every(validId) &&
    new Set(nodes).size === nodes.length,
    'nodi non validi o ripetuti'
  );

  assert(
    Array.isArray(c.legs) &&
    c.legs.length === nodes.length - 1,
    'tratte non coerenti'
  );

  const legs = c.legs.map(l => {
    assert(
      l &&
      Number.isFinite(l.metres) &&
      l.metres >= 0 &&
      Number.isFinite(l.seconds) &&
      (
        l.seconds > 0 ||
        (
          l.seconds === 0 &&
          l.metres === 0 &&
          l.roadCoincident === true
        )
      ) &&
      typeof l.polyline === 'string' &&
      l.polyline.length > 0,
      'tratta senza routing valido'
    );

    return {
      metres: l.metres,
      seconds: l.seconds,
      polyline: l.polyline,
      roadCoincident: l.roadCoincident === true
    };
  });

  // Stabile fra riavvii: non usare l'ID volatile px-N.
  return {
    nodes,
    legs,
    engineId: `territorial:${nodes.join('>')}`
  };
}

function normalizeOpportunities(instances, bufferMinuti) {
  assert(
    Array.isArray(instances),
    'opportunita non valide'
  );

  const result = [];
  const seen = new Set();

  for (const instance of instances) {
    const w = instance?.finestraPartenza;
    const start = w?.inizioMs;
    const end = w?.fineMs;

    assert(
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= start,
      'finestra partenza non valida'
    );

    assert(
      Array.isArray(instance.richiestaIds) &&
      instance.richiestaIds.length,
      'opportunita senza richieste'
    );

    const ids = [
      ...new Set(instance.richiestaIds.map(Number))
    ].sort((a, b) => a - b);

    assert(
      ids.every(validId) &&
      ids.length === instance.richiestaIds.length,
      'ID richieste non validi o duplicati'
    );

    const key = digest({
      start,
      end,
      ids,
      bufferMinuti
    });

    assert(
      !seen.has(key),
      'opportunita duplicata nel medesimo snapshot'
    );

    seen.add(key);

    result.push({
      start: toDate(start),
      end: toDate(end),
      ids,
      key,
      data: {
        fingerprint: key,
        bufferMinuti,
        istanzaIndice: instance.istanzaIndice ?? null,
        preliminare: instance.preliminare === true,
        massimaleTemporale:
          instance.massimaleTemporale === true,
        finestreRitornoPerNodo:
          instance.finestreRitornoPerNodo ?? {}
      }
    });
  }

  return result;
}

// Pubblica uno snapshot coerente di UNA direttrice;
// idempotente e serializzato per sequenza.
// Non consuma consumeOpportunityChanges():
// il chiamante deve fare retry in caso di errore.
export async function pubblicaOpportunitaPixel({
  engine,
  direttriceId,
  bufferMinuti = 0,
  client: externalClient = null
} = {}) {
  assert(
    engine &&
    typeof engine.getCorridor === 'function' &&
    typeof engine.temporalCandidatesCompleteWithReturns === 'function' &&
    typeof engine.opportunityRevision === 'function',
    'engine PIXEL non valido: opportunityRevision obbligatoria'
  );

  assert(
    Number.isFinite(bufferMinuti) && bufferMinuti >= 0,
    'bufferMinuti non valido'
  );

  const corridor = engine.getCorridor(direttriceId);

  assert(corridor, 'direttrice sconosciuta');

  const normalized = normalizeCorridor(corridor);

  const revisionBefore =
    engine.opportunityRevision(direttriceId);

  const instances =
    await engine.temporalCandidatesCompleteWithReturns(
      direttriceId,
      { bufferMinuti }
    );

  const revisionAfter =
    engine.opportunityRevision(direttriceId);

  assert(
    revisionBefore === revisionAfter,
    'revisione cambiata durante il calcolo: riprovare'
  );

  const current =
    normalizeCorridor(engine.getCorridor(direttriceId));

  assert(
    json(current.nodes) === json(normalized.nodes) &&
    json(current.legs) === json(normalized.legs),
    'routing cambiato: riprovare'
  );

  const opportunities =
    normalizeOpportunities(instances, bufferMinuti);

  // Con client esterno la transazione appartiene
  // esclusivamente al chiamante.
  const client =
    externalClient ?? await pool.connect();

  const ownsTransaction = externalClient === null;

  try {
    if (ownsTransaction) {
      await client.query('BEGIN');
    }

    // Lock transazionale: serializza gli snapshot
    // anche fra processi Node differenti.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [normalized.engineId]
    );

    const foundNodes = await client.query(
      `SELECT id
       FROM public.nodi_territoriali
       WHERE id = ANY($1::bigint[])
         AND attivo = TRUE`,
      [normalized.nodes]
    );

    assert(
      foundNodes.rowCount === normalized.nodes.length,
      'nodi territoriali inesistenti o inattivi'
    );

    const existing = await client.query(
      `SELECT id, versione, legs
       FROM public.pixel_direttrici
       WHERE engine_id = $1
       ORDER BY versione DESC
       LIMIT 1
       FOR UPDATE`,
      [normalized.engineId]
    );

    let row;

    if (!existing.rowCount) {
      const ins = await client.query(
        `INSERT INTO public.pixel_direttrici(
           engine_id,
           versione,
           nodi,
           legs
         )
         VALUES($1, 1, $2::bigint[], $3::jsonb)
         RETURNING id, versione`,
        [
          normalized.engineId,
          normalized.nodes,
          json(normalized.legs)
        ]
      );

      row = ins.rows[0];

    } else if (
      digest(
        existing.rows[0].legs.map(l => ({
          metres: Number(l.metres),
          seconds: Number(l.seconds),
          polyline: l.polyline,
          roadCoincident: l.roadCoincident === true
        }))
      ) !== digest(normalized.legs)
    ) {
      // La nuova geometria non deve riscrivere
      // versioni storiche gia usate.
      await client.query(
        `UPDATE public.pixel_direttrici
         SET stato = 'superata',
             updated_at = NOW()
         WHERE engine_id = $1
           AND stato = 'attiva'`,
        [normalized.engineId]
      );

      const ins = await client.query(
        `INSERT INTO public.pixel_direttrici(
           engine_id,
           versione,
           nodi,
           legs
         )
         VALUES(
           $1,
           $2,
           $3::bigint[],
           $4::jsonb
         )
         RETURNING id, versione`,
        [
          normalized.engineId,
          existing.rows[0].versione + 1,
          normalized.nodes,
          json(normalized.legs)
        ]
      );

      row = ins.rows[0];

      // Una versione precedente non deve restare
      // candidata per nuove attivazioni.
      await client.query(
        `UPDATE public.pixel_opportunita
         SET stato = 'superata'
         WHERE direttrice_id IN (
           SELECT id
           FROM public.pixel_direttrici
           WHERE engine_id = $1
             AND id <> $2
         )
         AND stato = 'candidata'`,
        [normalized.engineId, row.id]
      );

    } else {
      row = existing.rows[0];

      await client.query(
        `UPDATE public.pixel_direttrici
         SET stato = 'attiva',
             updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
    }

    // Nessun vincolo UNIQUE sull'opportunita:
    // la serializzazione e il fingerprint rendono
    // la pubblicazione idempotente per direttrice/versione.
    const previous = await client.query(
      `SELECT
         id,
         dati_temporali->>'fingerprint' AS fingerprint
       FROM public.pixel_opportunita
       WHERE direttrice_id = $1
       FOR UPDATE`,
      [row.id]
    );

    const byFingerprint = new Map(
      previous.rows
        .filter(r => r.fingerprint)
        .map(r => [r.fingerprint, r.id])
    );

    const retained = new Set();
    const opportunityIds = [];

    for (const o of opportunities) {
      let opportunityId = byFingerprint.get(o.key);

      if (opportunityId) {
        await client.query(
          `UPDATE public.pixel_opportunita
           SET stato = 'candidata',
               inizio_finestra = $2,
               fine_finestra = $3,
               dati_temporali = $4::jsonb
           WHERE id = $1`,
          [
            opportunityId,
            o.start,
            o.end,
            json(o.data)
          ]
        );

      } else {
        const inserted = await client.query(
          `INSERT INTO public.pixel_opportunita(
             direttrice_id,
             inizio_finestra,
             fine_finestra,
             dati_temporali
           )
           VALUES($1, $2, $3, $4::jsonb)
           RETURNING id`,
          [
            row.id,
            o.start,
            o.end,
            json(o.data)
          ]
        );

        opportunityId = inserted.rows[0].id;
      }

      retained.add(String(opportunityId));
      opportunityIds.push(Number(opportunityId));

      // Controllo aggiuntivo nel percorso E2E:
      // il client esterno consente di leggere
      // lo snapshot nella stessa transazione.
      //
      // Il controllo non elimina associazioni.
      // Blocca la pubblicazione se trova richieste
      // estranee al fingerprint dell'opportunita.
      if (externalClient) {
        const associations = await client.query(
          `SELECT richiesta_id
           FROM public.pixel_opportunita_richieste
           WHERE opportunita_id = $1
           ORDER BY richiesta_id`,
          [opportunityId]
        );

        const existingIds = associations.rows.map(
          r => Number(r.richiesta_id)
        );

        assert(
          existingIds.every(
            id => o.ids.includes(id)
          ),
          `associazioni obsolete per opportunita ${opportunityId}`
        );
      }

      // Non si eliminano candidature:
      // le attivazioni storiche possono dipenderne.
      for (const requestId of o.ids) {
        await client.query(
          `INSERT INTO public.pixel_opportunita_richieste(
             opportunita_id,
             richiesta_id
           )
           VALUES($1, $2)
           ON CONFLICT DO NOTHING`,
          [opportunityId, requestId]
        );
      }
    }

    for (const old of previous.rows) {
      if (!retained.has(String(old.id))) {
        await client.query(
          `UPDATE public.pixel_opportunita
           SET stato = 'superata'
           WHERE id = $1
             AND stato = 'candidata'`,
          [old.id]
        );
      }
    }

    // Rifiuta uno snapshot divenuto obsoleto
    // durante le scritture SQL.
    assert(
      engine.opportunityRevision(direttriceId) ===
        revisionAfter,
      'revisione PIXEL cambiata durante la pubblicazione: riprovare'
    );

    const finalCorridor =
      normalizeCorridor(engine.getCorridor(direttriceId));

    assert(
      json(finalCorridor.nodes) ===
        json(normalized.nodes) &&
      json(finalCorridor.legs) ===
        json(normalized.legs),
      'routing PIXEL cambiato: riprovare'
    );

    if (ownsTransaction) {
      await client.query('COMMIT');
    }

    return {
      direttricePixelId: row.id,
      versione: row.versione,
      opportunitaCandidate: opportunities.length,
      opportunityIds,
      revisioneEngine: revisionAfter
    };

  } catch (error) {
    if (ownsTransaction) {
      await client.query('ROLLBACK');
    }

    throw error;

  } finally {
    if (ownsTransaction) {
      client.release();
    }
  }
}

// Contratto di sola lettura per POPBUS:
// candidature, non assegnazioni.
// opportunityIds opzionale: filtro SQL prima del LIMIT,
// per isolare le fixture E2E.
export async function leggiOpportunitaPixel({
  limit = 100,
  client = null,
  opportunityIds = null
} = {}) {
  assert(
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 1000,
    'limit non valido'
  );

  assert(
    opportunityIds === null || (
      Array.isArray(opportunityIds) &&
      opportunityIds.length > 0 &&
      opportunityIds.every(validId) &&
      new Set(
        opportunityIds.map(Number)
      ).size === opportunityIds.length
    ),
    'opportunityIds non validi'
  );

  const { rows } = await (client ?? pool).query(
    `SELECT
       o.id AS pixel_opportunita_id,
       o.direttrice_id AS pixel_direttrice_id,
       d.versione,
       d.nodi,
       d.legs,
       o.inizio_finestra,
       o.fine_finestra,
       o.dati_temporali,
       ARRAY_AGG(
         r.richiesta_id
         ORDER BY r.richiesta_id
       ) AS richiesta_ids
     FROM public.pixel_opportunita o
     JOIN public.pixel_direttrici d
       ON d.id = o.direttrice_id
     JOIN public.pixel_opportunita_richieste r
       ON r.opportunita_id = o.id
     WHERE o.stato = 'candidata'
       AND d.stato = 'attiva'
       AND (
         $2::bigint[] IS NULL
         OR o.id = ANY($2::bigint[])
       )
     GROUP BY o.id, d.id
     ORDER BY o.inizio_finestra, o.id
     LIMIT $1`,
    [
      limit,
      opportunityIds === null
        ? null
        : opportunityIds.map(Number)
    ]
  );

  return rows;
}
