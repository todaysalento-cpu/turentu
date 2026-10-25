// services/pixel/pixel-stop-selection-comune.service.js
// PIXEL V5.4: Nearby Search spaziale nei round progressivi, Text Search iniziale. Nessuna scrittura.
import { pool } from '../../db/db.js';
import { discoverPixelStopCandidates, pixelDistanceMeters, PIXEL_GOOGLE_SEARCHES, getPixelDiscoveryContext } from './pixel-stop-discovery.service.js';
import { discoverPixelHybridStops } from './pixel-stop-hybrid-source.service.js';
import { classifyPixelStopCandidate } from './pixel-stop-classification.service.js';

function same(a, b) {
  return (a.place_id && b.place_id && a.place_id === b.place_id) || pixelDistanceMeters(a, b) < 30;
}

export function selectPixelComuneCandidates(risultati, limite, esistenti = [], { distanzaMinimaMetri = 500 } = {}) {
  if (!Number.isSafeInteger(limite) || limite < 0) throw new Error('Limite non valido');
  if (!Number.isFinite(distanzaMinimaMetri) || distanzaMinimaMetri < 0) throw new Error('Distanza minima non valida');
  const nodes = [...new Map(risultati.map(r => [String(r.nodo.id), r.nodo])).values()];
  const radiusByNode = new Map(risultati.map(r => [String(r.nodo.id), r.territoryRadiusMeters ?? r.radiusMeters ?? 3000]));
  // Solo le fermate operative impediscono la selezione geografica.
  // Quelle non operative restano censite e sono segnalate per riconciliazione.
  const operativeExisting = esistenti.filter(c => c.attiva === true && c.verificata === true);
  const uniqueExisting = [];
  for (const c of operativeExisting) if (!uniqueExisting.some(x => same(x, c))) uniqueExisting.push(c);
  const nonOperativeExisting = esistenti.filter(c => !(c.attiva === true && c.verificata === true));
  const candidates = [];
  for (const r of risultati) for (const c of r.candidati) {
    if (c.esistente_id || uniqueExisting.some(x => same(x, c))) continue;
    const found = candidates.find(x => same(x, c));
    if (!found) candidates.push({ ...classifyPixelStopCandidate(c), nodi_raggiungibili: [] });
    else if ((c.priorita ?? 0) > (found.priorita ?? 0)) {
      found.priorita = c.priorita;
      found.tipo = c.tipo;
      found.google_primary_type = c.google_primary_type ?? null;
      found.google_types = Array.isArray(c.google_types) ? [...c.google_types] : [];
      found.google_business_status = c.google_business_status ?? null;
      Object.assign(found, classifyPixelStopCandidate(found));
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
  const esclusi_vicinanza = [];
  const riserva = [];
  const available = [...candidates];
  const conflitto = c => {
    const vicino = [...uniqueExisting, ...selected].find(x => pixelDistanceMeters(x, c) < distanzaMinimaMetri);
    return vicino ? { nome: c.nome, place_id: c.place_id,
      vicino_a: vicino.place_id ?? null,
      distanza_m: Math.round(pixelDistanceMeters(vicino, c)) } : null;
  };
  const take = c => {
    const conflict = conflitto(c);
    if (conflict) {
      esclusi_vicinanza.push(conflict);
      riserva.push({ ...c, stato_selezione: 'riserva_vicinanza', motivo_esclusione: conflict });
      return false;
    }
    selected.push(c);
    for (const id of c.nodi_raggiungibili) covered.add(String(id));
    return true;
  };
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
    take(chosen);
    available.splice(available.indexOf(chosen), 1);
  }
  available.sort(byQuality);
  for (const c of [...available]) {
    if (selected.length >= limite) break;
    take(c);
    available.splice(available.indexOf(c), 1);
  }
  // Conserva in output anche i candidati non esaminati per limite di budget.
  for (const c of available) {
    if (!selected.includes(c) && !riserva.some(x => x.place_id === c.place_id)) {
      riserva.push({ ...c, stato_selezione: 'riserva_budget', motivo_esclusione: { codice: 'limite_budget' } });
    }
  }
  return {
    candidati_distinti: candidates.length,
    riserva,
    totale_riserva: riserva.length,
    distanza_minima_m: distanzaMinimaMetri,
    esclusi_vicinanza,
    totale_esclusi_vicinanza: esclusi_vicinanza.length,
    selezionati: selected,
    // Diagnostica: eventuali fermate censite non operative entro 500 m dai selezionati.
    riconciliazioni_non_operative: selected.flatMap(c => nonOperativeExisting
      .filter(x => pixelDistanceMeters(x, c) < distanzaMinimaMetri)
      .map(x => ({ candidato: c.nome, place_id: c.place_id, esistente_id: x.esistente_id,
        distanza_m: Math.round(pixelDistanceMeters(x, c)) }))),
    copertura_nodi: nodes.map(n => ({
      nodo: n.id,
      gia_coperto: coveredBefore.has(String(n.id)),
      candidati_selezionati_raggiungibili: selected.filter(c => c.nodi_raggiungibili.some(id => String(id) === String(n.id))).length,
    })),
  };
}


// Centri di esplorazione: griglia anulare ordinata per distanza dai punti gia' selezionati.
// Il territorio resta un disco centrato sul nodo: non equivale ai confini amministrativi.
function explorationCenters(nodo, round, distanzaMinimaMetri, territoryRadiusMeters, selected = [], visitedCenters = []) {
  const step = Math.max(600, distanzaMinimaMetri * 1.5);
  const radius = Math.min(territoryRadiusMeters * 0.9, Math.max(step, round * step));
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
  const rad = Math.PI / 180;
  return bearings.map(deg => {
    const angle = deg * rad;
    const center = {
      lat: nodo.lat + radius * Math.cos(angle) / 111320,
      lon: nodo.lon + radius * Math.sin(angle) / (111320 * Math.max(0.1, Math.cos(nodo.lat * rad))),
    };
    const distanceToSelected = selected.length ? Math.min(...selected.map(c => pixelDistanceMeters(c, center))) : radius;
    const distanceToVisited = visitedCenters.length ? Math.min(...visitedCenters.map(c => pixelDistanceMeters(c, center))) : radius;
    return { ...center, distanceToSelected, distanceToVisited };
  }).sort((a, b) => (b.distanceToSelected + b.distanceToVisited * 0.35) - (a.distanceToSelected + a.distanceToVisited * 0.35));
}

function integerOption(value, fallback, max) {
  const v = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new Error('Limite di ricerca non valido');
  return v;
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
    SELECT f.id, f.attiva, f.verificata, ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE n.codice_istat_comune = $1`, [codiceIstat]);
  const existing = existingRows.map(f => ({
    place_id: `turentu:${f.id}`, esistente_id: Number(f.id),
    lat: Number(f.lat), lon: Number(f.lon),
    attiva: f.attiva === true, verificata: f.verificata === true,
  }));
  const limite = Number(budgets[0].limite);
  const censite = existing.length;
  // Il budget rimane legato alle righe censite: non si altera la contabilità esistente.
  const residue = Math.max(0, limite - censite);
  if (!residue) return {
    comune: codiceIstat, source, limite, censite, residue,
    candidati_distinti: 0, selezionati: [], riserva: [], totale_riserva: 0, copertura_nodi: [], errori: [], stato: 'budget_esaurito',
  };
  const radiusMeters = options.radiusMeters ?? 3000;
  const distanzaMinimaMetri = options.distanzaMinimaMetri ?? 500;
  const maxGoogleCalls = integerOption(options.maxGoogleCalls, 48, 500);
  const maxRounds = integerOption(options.maxRounds, 3, 20);
  const searchRadiusMeters = options.searchRadiusMeters ?? Math.min(radiusMeters, 1500);
  const territoryRadiusMeters = options.territoryRadiusMeters ?? radiusMeters;
  if (!Number.isFinite(territoryRadiusMeters) || territoryRadiusMeters <= 0 || territoryRadiusMeters > 50000) throw new Error('territoryRadiusMeters non valido');
  const risultati = [];
  const errori = [];
  let chiamateGoogle = 0;
  let chiamateRiuscite = 0;
  let roundEseguiti = 0;
  let stopReason = 'budget_coperto';
  const visited = new Set();
  const diagnosticaRicerche = [];
  const seenPlaceIds = new Set();
  const visitedCenters = [];
  const categoryStats = new Map();
  const initialSearches = PIXEL_GOOGLE_SEARCHES;
  const contexts = new Map();
  for (const row of nodes) {
    if (source === 'GOOGLE') contexts.set(String(row.id), await getPixelDiscoveryContext(row.id));
  }
  const runSearch = async (row, center, searches, radius, round) => {
    const searchMode = round === 0 ? 'TEXT' : 'NEARBY';
    const usable = [];
    for (const search of searches) {
      if (chiamateGoogle + usable.length >= maxGoogleCalls) break;
      const key = `${row.id}:${searchMode}:${center.lat.toFixed(5)}:${center.lon.toFixed(5)}:${search.tipo}`;
      if (visited.has(key)) continue;
      visited.add(key);
      usable.push(search);
    }
    if (!usable.length) return false;
    // Conteggio eseguito dal discovery immediatamente prima di ogni chiamata.
    // Non equivale al conteggio fatturato dal provider.
    const before = selectPixelComuneCandidates(risultati, residue, existing, { distanzaMinimaMetri });
    const result = await discoverPixelStopCandidates(row.id, {
      ...options, radiusMeters: radius, includeAll: true,
      searchCenter: center, territoryRadiusMeters, searches: usable, searchMode,
      onGoogleAttempt: () => { chiamateGoogle++; },
    });
    chiamateRiuscite += result.chiamate_google_riuscite ?? 0;
    risultati.push({ ...result, radiusMeters: territoryRadiusMeters, territoryRadiusMeters, round });
    visitedCenters.push(center);
    const after = selectPixelComuneCandidates(risultati, residue, existing, { distanzaMinimaMetri });
    const nuoveSelezionate = after.selezionati.filter(c => !before.selezionati.some(x => same(x, c)));
    // Place ID nuovi sono misurati sui candidati ammessi, non sui risultati grezzi.
    const nuoviPlaceIds = result.candidati.filter(c => c.place_id && !seenPlaceIds.has(c.place_id));
    for (const c of result.candidati) if (c.place_id) seenPlaceIds.add(c.place_id);
    for (const category of usable) {
      const stat = categoryStats.get(category.tipo) ?? { tentativi: 0, nuovi: 0 };
      stat.tentativi++; stat.nuovi += nuoviPlaceIds.filter(c => c.tipo === category.tipo).length;
      categoryStats.set(category.tipo, stat);
    }
    for (const [diagIndex, diag] of (result.diagnostica_ricerche ?? []).entries()) {
      diagnosticaRicerche.push({ nodo_id: String(row.id), round,
        ...diag, nuovi_place_id_ammessi_batch: diagIndex === 0 ? nuoviPlaceIds.length : null,
        nuovi_candidati_geografici_batch: diagIndex === 0 ? Math.max(0, after.candidati_distinti - before.candidati_distinti) : null,
        candidati_distinti_comune_prima: before.candidati_distinti,
        candidati_distinti_comune_dopo: after.candidati_distinti,
        selezionati_prima: before.selezionati.length,
        selezionati_dopo: after.selezionati.length,
        nuovi_selezionati_batch: diagIndex === 0 ? nuoveSelezionate.map(c => ({ nome: c.nome, place_id: c.place_id })) : [],
        riserva_dopo: after.totale_riserva });
    }
    errori.push(...(result.errori ?? []).map(e => ({ nodo: row.id, round, ...e })));
    return true;
  };
  // Passata iniziale: una ricerca per ciascuna delle sei categorie, per nodo.
  for (const row of nodes) {
    if (source === 'HYBRID') {
      const result = await discoverPixelHybridStops(row.id, { ...options, database, radiusMeters });
      risultati.push({ ...result, radiusMeters, round: 0 });
      errori.push(...(result.errori ?? []).map(e => ({ nodo: row.id, round: 0, ...e })));
    } else {
      if (chiamateGoogle >= maxGoogleCalls) break;
      await runSearch(row, contexts.get(String(row.id)).nodo, initialSearches, radiusMeters, 0);
    }
  }
  const select = () => selectPixelComuneCandidates(risultati, residue, existing, { distanzaMinimaMetri });
  let scelta = select();
  // Esplorazione progressiva: UNA categoria per centro. In questo modo
  // le sei categorie iniziali non consumano l'intero budget su un solo punto.
  if (source === 'GOOGLE' && scelta.selezionati.length < residue) {
    for (let round = 1; round <= maxRounds; round++) {
      if (chiamateGoogle >= maxGoogleCalls) { stopReason = 'limite_chiamate'; break; }
      let searchesThisRound = 0;
      for (const row of nodes) {
        const nodo = contexts.get(String(row.id)).nodo;
        const centers = explorationCenters(nodo, round, distanzaMinimaMetri, territoryRadiusMeters, scelta.selezionati, visitedCenters);
        for (let i = 0; i < centers.length; i++) {
          if (chiamateGoogle >= maxGoogleCalls || scelta.selezionati.length >= residue) break;
          const center = centers[i];
          // Favorisce categorie produttive e trasporto locale; penalizza quelle ripetitive.
          const categories = [initialSearches[5], initialSearches[1], initialSearches[0],
            initialSearches[3], initialSearches[2], initialSearches[4]].filter(Boolean);
          const ranked = categories.map((category, index) => {
            const stat = categoryStats.get(category.tipo) ?? { tentativi: 0, nuovi: 0 };
            const prior = category.tipo === 'trasporto' ? 2 : category.tipo === 'autobus' ? 1 : 0;
            return { category, score: prior + (stat.nuovi / Math.max(1, stat.tentativi)) * 3 - stat.tentativi * 0.2, index };
          }).sort((a, b) => b.score - a.score || a.index - b.index);
          const category = ranked[(i + round - 1) % Math.min(3, ranked.length)].category;
          const done = await runSearch(row, center, [category], searchRadiusMeters, round);
          if (done) { searchesThisRound++; scelta = select(); }
        }
      }
      if (searchesThisRound) roundEseguiti = round;
      if (scelta.selezionati.length >= residue) { stopReason = 'budget_coperto'; break; }
      if (!searchesThisRound) { stopReason = 'nessuna_ricerca_disponibile'; break; }
      stopReason = chiamateGoogle >= maxGoogleCalls ? 'limite_chiamate' : 'limite_round';
    }
  } else if (source === 'HYBRID') stopReason = 'fonte_non_progressiva';
  if (source === 'GOOGLE' && scelta.selezionati.length < residue && maxRounds === 0) stopReason = 'ricerca_supplementare_disabilitata';
  if (source === 'GOOGLE' && scelta.selezionati.length < residue && chiamateGoogle >= maxGoogleCalls) stopReason = 'limite_chiamate';
  return {
    comune: codiceIstat, source, nodi: nodes.length, limite, censite, residue,
    candidati_locali_sommati: risultati.reduce((sum, r) => sum + r.candidati.length, 0),
    ...scelta, errori, stato: errori.length ? 'parziale' : 'ok',
    discovery_progressiva: {
      round_eseguiti: roundEseguiti, chiamate_google_previste: chiamateGoogle,
      chiamate_google_tentate: chiamateGoogle, chiamate_google_riuscite: chiamateRiuscite,
      max_google_calls: maxGoogleCalls, motivo_arresto: stopReason,
      territorio_raggio_m: territoryRadiusMeters, raggio_ricerca_supplementare_m: searchRadiusMeters,
      modalita_iniziale: 'TEXT', modalita_supplementare: 'NEARBY',
      avvertenza_territorio: 'Territorio modellato come raggio dal nodo, non come confine amministrativo comunale',
      posti_non_coperti: Math.max(0, residue - scelta.selezionati.length),
      diagnostica: {
        ricerche: diagnosticaRicerche,
        riepilogo: {
          risultati_grezzi: diagnosticaRicerche.reduce((a, x) => a + x.risultati_grezzi, 0),
          categoria_non_ammessa: diagnosticaRicerche.reduce((a, x) => a + x.categoria_non_ammessa, 0),
          fuori_raggio: diagnosticaRicerche.reduce((a, x) => a + x.fuori_raggio, 0),
          duplicati_place_id_locali: diagnosticaRicerche.reduce((a, x) => a + x.duplicati_place_id_locali, 0),
          fuori_territorio: diagnosticaRicerche.reduce((a, x) => a + (x.fuori_territorio ?? 0), 0),
          produttivita_categorie: Object.fromEntries(categoryStats),
          nuovi_place_id_ammessi_per_batch: diagnosticaRicerche.reduce((a, x) => a + (x.nuovi_place_id_ammessi_batch ?? 0), 0),
          nuovi_candidati_geografici_per_batch: diagnosticaRicerche.reduce((a, x) => a + (x.nuovi_candidati_geografici_batch ?? 0), 0),
          candidati_distinti_finali: scelta.candidati_distinti,
          selezionati_finali: scelta.selezionati.length,
        },
      },
    },
    avvertenza: 'Discovery Google progressiva e selezione in memoria: nessuna scrittura o attivazione. Dati Places transitori.',
  };
}
