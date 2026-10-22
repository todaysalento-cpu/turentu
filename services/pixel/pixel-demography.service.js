// services/pixel/pixel-demography.service.js
// PIXEL: calcolo del massimo fermate da dati demografici verificati.
// Non acquisisce dati esterni. Non modifica POPBUS.
import { pool } from '../../db/db.js';

export const PIXEL_FERMATE_FASCE = Object.freeze([
  { finoA: 5000, max: 3 },
  { finoA: 15000, max: 5 },
  { finoA: 50000, max: 8 },
  { finoA: 150000, max: 10 },
  { finoA: 500000, max: 12 },
  { finoA: Infinity, max: 15 },
]);

export function calcolaMaxFermate(popolazione) {
  if (!Number.isSafeInteger(popolazione) || popolazione < 0) {
    throw new TypeError('PIXEL_DEMOGRAFIA: popolazione intera non negativa obbligatoria');
  }
  return PIXEL_FERMATE_FASCE.find(f => popolazione <= f.finoA).max;
}

const QUERY = `
  SELECT n.id, n.nome, n.max_fermate_auto, n.max_fermate_override,
         d.localita, d.popolazione, d.anno_riferimento,
         d.livello_territoriale, d.fonte
  FROM public.nodi_territoriali n
  LEFT JOIN public.pixel_demografia d ON d.nodo_territoriale_id = n.id
  WHERE n.id = ANY($1::bigint[])
  ORDER BY n.id
`;

export async function diagnosticaDemografiaPixel(ids = [1,2,3,4,5,6,7,8,9]) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError('PIXEL_DEMOGRAFIA: ids non validi');
  }
  const { rows } = await pool.query(QUERY, [ids]);
  return rows.map(r => {
    const completa = Number.isSafeInteger(r.popolazione) &&
      r.popolazione >= 0 && !!r.localita && !!r.fonte &&
      Number.isSafeInteger(r.anno_riferimento) &&
      ['comune', 'frazione', 'centro_abitato'].includes(r.livello_territoriale);
    const calcolato = completa ? calcolaMaxFermate(r.popolazione) : null;
    return {
      ...r,
      stato: completa ? 'calcolabile' : 'dati_demografici_incompleti',
      max_fermate_calcolato: calcolato,
      max_fermate_effettivo: r.max_fermate_override ?? calcolato ?? r.max_fermate_auto,
    };
  });
}

export async function aggiornaMaxFermateAutoPixel(ids = [1,2,3,4,5,6,7,8,9]) {
  const diagnosi = await diagnosticaDemografiaPixel(ids);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const aggiornati = [];
    for (const r of diagnosi) {
      if (r.stato !== 'calcolabile') continue;
      const result = await client.query(`
        UPDATE public.nodi_territoriali n
        SET max_fermate_auto = $2
        WHERE n.id = $1
          AND EXISTS (
            SELECT 1 FROM public.pixel_demografia d
            WHERE d.nodo_territoriale_id = n.id
              AND d.popolazione = $3
              AND d.localita IS NOT NULL
              AND d.fonte IS NOT NULL
              AND d.anno_riferimento IS NOT NULL
              AND d.livello_territoriale IN ('comune','frazione','centro_abitato')
          )
        RETURNING id, max_fermate_auto, max_fermate_override
      `, [r.id, r.max_fermate_calcolato, r.popolazione]);
      if (result.rows[0]) aggiornati.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return { aggiornati, saltati: diagnosi.filter(r => r.stato !== 'calcolabile').map(r => r.id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
