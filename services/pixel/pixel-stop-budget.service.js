// services/pixel/pixel-stop-budget.service.js
// Budget condiviso per comune; supporta transazioni esterne per registrazione atomica.
import { pool } from '../../db/db.js';

function validateId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${name} non valido`);
  return id;
}

async function readBudget(client, nodeId, lock = false) {
  const node = await client.query(
    `SELECT id, codice_istat_comune FROM public.nodi_territoriali
     WHERE id = $1 AND attivo = TRUE`, [nodeId]
  );
  if (!node.rowCount) throw new Error(`Nodo territoriale ${nodeId} inesistente o inattivo`);
  const code = node.rows[0].codice_istat_comune;
  if (!code) throw new Error(`Nodo ${nodeId} senza codice ISTAT comunale`);

  const budget = await client.query(
    `SELECT codice_istat_comune, max_fermate_auto, max_fermate_override,
            COALESCE(max_fermate_override, max_fermate_auto) AS limite
     FROM public.pixel_budget_comunali
     WHERE codice_istat_comune = $1 ${lock ? 'FOR UPDATE' : ''}`, [code]
  );
  if (!budget.rowCount) throw new Error(`Budget comunale non configurato: ${code}`);
  const count = await client.query(
    `SELECT COUNT(*)::integer AS censite
     FROM public.pixel_fermate f
     JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
     WHERE n.codice_istat_comune = $1`, [code]
  );
  const limite = Number(budget.rows[0].limite);
  const censite = Number(count.rows[0].censite);
  return {
    codice_istat_comune: code,
    limite,
    censite,
    residue: Math.max(0, limite - censite),
    sovraccarico: Math.max(0, censite - limite),
  };
}

export async function getPixelStopBudget(nodoTerritorialeId) {
  const id = validateId(nodoTerritorialeId, 'nodoTerritorialeId');
  const client = await pool.connect();
  try { return await readBudget(client, id); }
  finally { client.release(); }
}

// Se viene passato client, il chiamante gestisce BEGIN/COMMIT/ROLLBACK.
// Se non viene passato, questa funzione mantiene la gestione autonoma precedente.
export async function insertPixelStopCandidate({
  nodo_territoriale_id, nome, indirizzo = null, lat, lon,
}, { client: externalClient } = {}) {
  const id = validateId(nodo_territoriale_id, 'nodo_territoriale_id');
  if (typeof nome !== 'string' || !nome.trim()) throw new Error('nome obbligatorio');
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('lat non valida');
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('lon non valida');

  const owned = !externalClient;
  const client = externalClient ?? await pool.connect();
  try {
    if (owned) await client.query('BEGIN');
    const before = await readBudget(client, id, true);

    // Cercare i duplicati prima del controllo budget permette di riutilizzare
    // una fermata già censita anche quando il comune ha esaurito i posti.
    const duplicate = await client.query(
      `SELECT f.id, f.nodo_territoriale_id
       FROM public.pixel_fermate f
       JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
       WHERE n.codice_istat_comune = $1
         AND ST_DWithin(f.posizione,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 30)
       ORDER BY ST_Distance(f.posizione,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography), f.id
       LIMIT 1`, [before.codice_istat_comune, lon, lat]
    );
    if (duplicate.rowCount) {
      if (owned) await client.query('COMMIT');
      return {
        inserted: false, reason: 'duplicata_vicina',
        existing_id: duplicate.rows[0].id,
        existing_nodo_territoriale_id: duplicate.rows[0].nodo_territoriale_id,
        budget: before,
      };
    }
    if (before.residue === 0) {
      if (owned) await client.query('COMMIT');
      return { inserted: false, reason: 'budget_esaurito', budget: before };
    }
    const inserted = await client.query(
      `INSERT INTO public.pixel_fermate
       (nodo_territoriale_id, nome, indirizzo, posizione, verificata, attiva)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, FALSE, FALSE)
       RETURNING id`, [id, nome.trim(), indirizzo, lon, lat]
    );
    const after = { ...before, censite: before.censite + 1, residue: before.residue - 1 };
    if (owned) await client.query('COMMIT');
    return { inserted: true, id: inserted.rows[0].id, budget: after };
  } catch (error) {
    if (owned) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (owned) client.release();
  }
}
