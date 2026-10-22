// services/pixel/pixel-stop-selection-comune.service.js
// Selezione coordinata a livello di comune. Solo memoria, nessuna scrittura.
import { pool } from '../../db/db.js';
import { discoverPixelStopCandidates, pixelDistanceMeters } from './pixel-stop-discovery.service.js';

function isSame(a, b) {
  return a.place_id === b.place_id || pixelDistanceMeters(a, b) < 30;
}

// Funzione pura, testabile senza DB e senza Google.
export function selectPixelComuneCandidates(risultati, limite) {
  if (!Number.isSafeInteger(limite) || limite < 0) throw new Error('Limite non valido');
  const nodes = risultati.map(r => r.nodo);
  const poolCandidati = [];
  for (const r of risultati) {
    for (const c of r.candidati) {
      let found = poolCandidati.find(x => isSame(x, c));
      if (!found) {
        found = { ...c, nodi_raggiungibili: [] };
        poolCandidati.push(found);
      }
      if (c.priorita > found.priorita) {
        found.priorita = c.priorita;
        found.tipo = c.tipo;
      }
    }
  }
  // Copertura geografica reale: un candidato puo' coprire piu' nodi.
  // Si usa il raggio realmente impiegato in fase di scoperta.
  for (const c of poolCandidati) {
    c.nodi_raggiungibili = nodes.filter(n =>
      pixelDistanceMeters(n, c) <= (risultati.find(r => r.nodo.id === n.id)?.radiusMeters ?? 3000)
    ).map(n => n.id);
  }
  const selected = [];
  const covered = new Set();
  const available = [...poolCandidati];
  const byQuality = (a, b) => b.priorita - a.priorita ||
    b.nodi_raggiungibili.length - a.nodi_raggiungibili.length ||
    a.place_id.localeCompare(b.place_id);
  // Prima copertura: finche' possibile, copri i nodi non ancora serviti.
  while (selected.length < limite) {
    const uncovered = nodes.filter(n => !covered.has(n.id));
    if (!uncovered.length) break;
    const ranked = available.filter(c => c.nodi_raggiungibili.some(id => !covered.has(id)))
      .sort((a, b) => {
        const gainA = a.nodi_raggiungibili.filter(id => !covered.has(id)).length;
        const gainB = b.nodi_raggiungibili.filter(id => !covered.has(id)).length;
        return gainB - gainA || byQuality(a, b);
      });
    if (!ranked.length) break;
    const chosen = ranked[0];
    selected.push(chosen);
    for (const id of chosen.nodi_raggiungibili) covered.add(id);
    available.splice(available.indexOf(chosen), 1);
  }
  // Poi qualita' strategica e copertura multipla, senza quote rigide.
  available.sort(byQuality);
  selected.push(...available.slice(0, Math.max(0, limite - selected.length)));
  return { candidati_distinti: poolCandidati.length, selezionati: selected,
    copertura_nodi: nodes.map(n => ({ nodo: n.id,
      candidati_selezionati_raggiungibili: selected.filter(c => c.nodi_raggiungibili.includes(n.id)).length })) };
}

export async function discoverPixelComuneCandidates(codiceIstat, options = {}) {
  if (!/^\d{6}$/.test(String(codiceIstat))) throw new Error('Codice ISTAT comunale non valido');
  const { rows } = await pool.query(`
    SELECT id FROM public.nodi_territoriali
    WHERE codice_istat_comune = $1 AND attivo = TRUE ORDER BY id`, [codiceIstat]);
  if (!rows.length) throw new Error('Nessun nodo attivo per il comune');
  // Unica fonte del limite: tabella comunale; non sommare budget per nodo.
  const { rows: budgets } = await pool.query(`
    SELECT COALESCE(max_fermate_override, max_fermate_auto) AS limite
    FROM public.pixel_budget_comunali WHERE codice_istat_comune = $1`, [codiceIstat]);
  if (!budgets.length) throw new Error('Budget comunale assente');
  const { rows: counts } = await pool.query(`
    SELECT COUNT(f.id)::int AS censite FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE n.codice_istat_comune = $1`, [codiceIstat]);
  const limite = Number(budgets[0].limite);
  const censite = Number(counts[0].censite);
  const residue = Math.max(0, limite - censite);
  if (!residue) return { comune: codiceIstat, limite, censite, residue,
    candidati_distinti: 0, selezionati: [], copertura_nodi: [], errori: [], stato: 'budget_esaurito' };
  const radiusMeters = options.radiusMeters ?? 3000;
  const risultati = [];
  for (const row of rows) {
    const result = await discoverPixelStopCandidates(row.id, { ...options, radiusMeters, includeAll: true });
    risultati.push({ ...result, radiusMeters });
  }
  const scelta = selectPixelComuneCandidates(risultati, residue);
  const errori = risultati.flatMap(r => r.errori.map(e => ({ nodo: r.nodo.id, ...e })));
  return { comune: codiceIstat, nodi: risultati.length, limite, censite, residue,
    candidati_locali_sommati: risultati.reduce((sum, r) => sum + r.candidati.length, 0),
    ...scelta, errori, stato: errori.length ? 'parziale' : 'ok',
    avvertenza: 'Solo selezione transitoria in memoria. Nessuna fermata salvata o verificata.' };
}
