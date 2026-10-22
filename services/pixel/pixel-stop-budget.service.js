// services/pixel/pixel-stop-budget.service.js
// PIXEL: budget condiviso per comune. ESM, PostgreSQL/PostGIS.
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

  // Lock sulla riga comunale: serializza le acquisizioni che passano da questo servizio.
  const budget = await client.query(
    `SELECT codice_istat_comune, max_fermate_auto, max_fermate_override,
            COALESCE(max_fermate_override, max_fermate_auto) AS limite
     FROM public.pixel_budget_comunali
     WHERE codice_istat_comune = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [code]
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

// Diagnostica, nessuna scrittura.
export async function getPixelStopBudget(nodoTerritorialeId) {
  const id = validateId(nodoTerritorialeId, 'nodoTerritorialeId');
  const client = await pool.connect();
  try { return await readBudget(client, id); }
  finally { client.release(); }
}

// Inserisce una fermata candidata INATTIVA e NON VERIFICATA, nel limite comunale.
// Tutti i writer automatici di pixel_fermate devono usare questa funzione.
export async function insertPixelStopCandidate({
  nodo_territoriale_id, nome, indirizzo = null, lat, lon,
}) {
  const id = validateId(nodo_territoriale_id, 'nodo_territoriale_id');
  if (typeof nome !== 'string' || !nome.trim()) throw new Error('nome obbligatorio');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('lat non valida');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('lon non valida');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await readBudget(client, id, true);
    if (before.residue === 0) {
      await client.query('COMMIT');
      return { inserted: false, reason: 'budget_esaurito', budget: before };
    }
    // Evita doppioni geografici nello stesso comune (raggio 30 m).
    const duplicate = await client.query(
      `SELECT f.id FROM public.pixel_fermate f
       JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
       WHERE n.codice_istat_comune = $1
         AND ST_DWithin(f.posizione,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 30)
       LIMIT 1`, [before.codice_istat_comune, lon, lat]
    );
    if (duplicate.rowCount) {
      await client.query('COMMIT');
      return { inserted: false, reason: 'duplicata_vicina', existing_id: duplicate.rows[0].id, budget: before };
    }
    const inserted = await client.query(
      `INSERT INTO public.pixel_fermate
       (nodo_territoriale_id, nome, indirizzo, posizione, verificata, attiva)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, FALSE, FALSE)
       RETURNING id`, [id, nome.trim(), indirizzo, lon, lat]
    );
    const after = { ...before, censite: before.censite + 1, residue: before.residue - 1 };
    await client.query('COMMIT');
    return { inserted: true, id: inserted.rows[0].id, budget: after };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
