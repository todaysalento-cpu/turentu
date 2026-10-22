// services/pixel/pixel-stop-selection-comune.service.js
// PIXEL: selezione comunale unica; Google SHADOW oppure OSM + Turentu HYBRID.
// Nessuna scrittura e nessuna attivazione automatica.
import { pool } from '../../db/db.js';
import { discoverPixelStopCandidates, pixelDistanceMeters } from './pixel-stop-discovery.service.js';
import { discoverPixelHybridStops } from './pixel-stop-hybrid-source.service.js';

function same(a, b) {
  return (a.place_id && b.place_id && a.place_id === b.place_id) || pixelDistanceMeters(a, b) < 30;
}

// Funzione pura. Le fermate esistenti contribuiscono alla copertura,
// ma NON consumano nuovi slot di selezione (gia' conteggiate nel budget DB).
export function selectPixelComuneCandidates(risultati, limite, esistenti = []) {
  if (!Number.isSafeInteger(limite) || limite < 0) throw new Error('Limite non valido');
  const nodes = risultati.map(r => r.nodo);
  const radiusByNode = new Map(risultati.map(r => [String(r.nodo.id), r.radiusMeters ?? 3000]));
  const uniqueExisting = [];
  for (const c of esistenti) if (!uniqueExisting.some(x => same(x, c))) uniqueExisting.push(c);
  const candidates = [];
  for (const r of risultati) for (const c of r.candidati) {
    if (c.esistente_id || uniqueExisting.some(x => same(x, c))) continue;
    const found = candidates.find(x => same(x, c));
    if (!found) candidates.push({ ...c, nodi_raggiungibili: [] });
    else if ((c.priorita ?? 0) > (found.priorita ?? 0)) {
      found.priorita = c.priorita;
      found.tipo = c.tipo;
    }
  }
  for (const c of candidates) {
    c.nodi_raggiungibili = nodes.filter(n =>
      pixelDistanceMeters(n, c) <= radiusByNode.get(String(n.id))
    ).map(n => n.id);
  }
  const covered = new Set();
  for (const n of nodes) {
    if (uniqueExisting.some(c => pixelDistanceMeters(n, c) <= radiusByNode.get(String(n.id)))) {
      covered.add(String(n.id));
    }
  }
  const coveredBefore = new Set(covered);
  const selected = [];
  const available = [...candidates];
  const byQuality = (a, b) => (b.priorita ?? 0) - (a.priorita ?? 0) ||
    b.nodi_raggiungibili.length - a.nodi_raggiungibili.length ||
    String(a.place_id ?? '').localeCompare(String(b.place_id ?? ''));
  while (selected.length < limite) {
    const ranked = available.filter(c => c.nodi_raggiungibili.some(id => !covered.has(String(id))))
      .sort((a, b) => {
        const gainA = a.nodi_raggiungibili.filter(id => !covered.has(String(id))).length;
        const gainB = b.nodi_raggiungibili.filter(id => !covered.has(String(id))).length;
        return gainB - gainA || byQuality(a, b);
      });
    if (!ranked.length) break;
    const chosen = ranked[0];
    selected.push(chosen);
    for (const id of chosen.nodi_raggiungibili) covered.add(String(id));
    available.splice(available.indexOf(chosen), 1);
  }
  available.sort(byQuality);
  selected.push(...available.slice(0, Math.max(0, limite - selected.length)));
  return {
    candidati_distinti: candidates.length,
    selezionati: selected,
    copertura_nodi: nodes.map(n => ({
      nodo: n.id,
      gia_coperto: coveredBefore.has(String(n.id)),
      candidati_selezionati_raggiungibili: selected.filter(c => c.nodi_raggiungibili.some(id => String(id) === String(n.id))).length,
    })),
  };
}

export async function discoverPixelComuneCandidates(codiceIstat, options = {}) {
  if (!/^\d{6}$/.test(String(codiceIstat))) throw new Error('Codice ISTAT comunale non valido');
  const source = String(options.source ?? 'GOOGLE').toUpperCase();
  if (!['GOOGLE', 'HYBRID'].includes(source)) throw new Error('Fonte non supportata: GOOGLE o HYBRID');
  const database = options.database ?? pool;
  const { rows: nodes } = await database.query(`
    SELECT id FROM public.nodi_territoriali
    WHERE codice_istat_comune = $1 AND attivo = TRUE ORDER BY id`, [codiceIstat]);
  if (!nodes.length) throw new Error('Nessun nodo attivo per il comune');
  const { rows: budgets } = await database.query(`
    SELECT COALESCE(max_fermate_override, max_fermate_auto) AS limite
    FROM public.pixel_budget_comunali WHERE codice_istat_comune = $1`, [codiceIstat]);
  if (!budgets.length) throw new Error('Budget comunale assente');
  const { rows: existingRows } = await database.query(`
    SELECT f.id, ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE n.codice_istat_comune = $1`, [codiceIstat]);
  const existing = existingRows.map(f => ({
    place_id: `turentu:${f.id}`, esistente_id: Number(f.id),
    lat: Number(f.lat), lon: Number(f.lon),
  }));
  const limite = Number(budgets[0].limite);
  const censite = existing.length;
  const residue = Math.max(0, limite - censite);
  if (!residue) return {
    comune: codiceIstat, source, limite, censite, residue,
    candidati_distinti: 0, selezionati: [], copertura_nodi: [], errori: [], stato: 'budget_esaurito',
  };
  const radiusMeters = options.radiusMeters ?? 3000;
  const risultati = [];
  for (const row of nodes) {
    const result = source === 'HYBRID'
      ? await discoverPixelHybridStops(row.id, { ...options, database, radiusMeters })
      : await discoverPixelStopCandidates(row.id, { ...options, radiusMeters, includeAll: true });
    risultati.push({ ...result, radiusMeters });
  }
  const scelta = selectPixelComuneCandidates(risultati, residue, existing);
  const errori = risultati.flatMap(r => (r.errori ?? []).map(e => ({ nodo: r.nodo.id, ...e })));
  return {
    comune: codiceIstat, source, nodi: risultati.length, limite, censite, residue,
    candidati_locali_sommati: risultati.reduce((sum, r) => sum + r.candidati.length, 0),
    ...scelta, errori, stato: errori.length ? 'parziale' : 'ok',
    avvertenza: 'Selezione in memoria. Nessuna registrazione o attivazione. OSM soggetto a ODbL e attribuzione.',
  };
}
