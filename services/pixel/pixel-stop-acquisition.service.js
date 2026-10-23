import { pool } from '../../db/db.js';
import { discoverPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';
import { insertPixelStopCandidate } from './pixel-stop-budget.service.js';
import { pixelCollaudoEnabled } from './pixel-collaudo-mode.js';

// Invocata solo quando un nodo non ha fermate persistite. Non attiva le fermate.
export async function ensurePixelStopsForNode(nodoId) {
  if (!pixelCollaudoEnabled()) throw new Error('Acquisizione PIXEL collaudo disabilitata');
  const { rows: nodes } = await pool.query(`
    SELECT id, codice_istat_comune FROM public.nodi_territoriali
    WHERE id=$1::bigint AND attivo=TRUE`, [nodoId]);
  const node = nodes[0];
  if (!node?.codice_istat_comune) return { stato: 'nodo_non_disponibile' };

  const { rows: existing } = await pool.query(
    'SELECT id FROM public.pixel_fermate WHERE nodo_territoriale_id=$1::bigint LIMIT 1', [nodoId]);
  if (existing.length) return { stato: 'gia_presenti' };

  // HYBRID: candidati OSM/Turentu; non memorizzare candidati Google senza
  // verificare le condizioni di licenza e persistenza del provider.
  const plan = await discoverPixelComuneCandidates(String(node.codice_istat_comune), { source: 'HYBRID' });
  if (plan.stato !== 'ok') return { stato: plan.stato, errori: plan.errori ?? [] };

  let inserite = 0;
  for (const c of plan.selezionati ?? []) {
    if (!(c.nodi_raggiungibili ?? []).some(id => String(id) === String(nodoId))) continue;
    const lat = Number(c.lat), lon = Number(c.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !String(c.nome ?? '').trim()) continue;
    const result = await insertPixelStopCandidate({
      nodo_territoriale_id: Number(nodoId), nome: c.nome,
      indirizzo: c.indirizzo ?? null, lat, lon,
    });
    if (result.inserted) inserite++;
    if (result.reason === 'budget_esaurito') break;
  }
  return { stato: inserite ? 'acquisite' : 'nessuna_acquisizione', inserite };
}
