// tests/test-pixel-stop-discovery-comune.js
// Diagnostica transitoria in memoria: non salva né stampa dati Google Places.
// Uso: node --env-file=.env tests/test-pixel-stop-discovery-comune.js 075088
import { pool } from '../db/db.js';
import { discoverPixelStopCandidates } from '../services/pixel/pixel-stop-discovery.service.js';

function distance(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lat - a.lat) * rad;
  const y = (b.lon - a.lon) * rad;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(y / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function samePlace(a, b) {
  return a.place_id === b.place_id || distance(a, b) < 30;
}

try {
  const comune = process.argv[2];
  if (!/^\d{6}$/.test(comune ?? '')) throw new Error('Uso: <codice_istat_comune a 6 cifre>');
  const { rows } = await pool.query(`
    SELECT id, nome FROM public.nodi_territoriali
    WHERE codice_istat_comune = $1 AND attivo = TRUE ORDER BY id`, [comune]);
  if (!rows.length) throw new Error('Nessun nodo attivo per il comune');

  const results = [];
  for (const row of rows) {
    const result = await discoverPixelStopCandidates(row.id);
    results.push(result);
  }
  const limite = results[0].budget.limite;
  const residue = results[0].budget.residue;
  if (results.some(r => r.budget.limite !== limite || r.budget.residue !== residue)) {
    throw new Error('Budget non coerente fra i nodi del comune');
  }
  console.log('PIXEL - DIAGNOSTICA COMUNALE TRANSITORIA (NESSUNA SCRITTURA)');
  console.table(results.map(r => ({
    nodo: r.nodo.id, nome: r.nodo.nome,
    trovati: r.candidati_totali ?? 0, selezionati_locali: r.candidati.length,
    stato: r.stato, errori: r.errori.length
  })));

  // Con l'API attuale si ricevono solo i primi `residue` candidati di ogni nodo.
  // La selezione è quindi una diagnosi parziale, non un ottimizzatore definitivo.
  const unique = [];
  let overlaps = 0;
  for (const r of results) {
    for (const candidate of r.candidati) {
      const existing = unique.find(x => samePlace(x.candidate, candidate));
      if (existing) { existing.nodi.add(r.nodo.id); overlaps++; }
      else unique.push({ candidate, nodi: new Set([r.nodo.id]) });
    }
  }

  const selected = [];
  // Prima un candidato distinto per ogni nodo, se disponibile.
  for (const r of results) {
    const candidate = unique.find(x => x.nodi.has(r.nodo.id) && !selected.includes(x));
    if (candidate && selected.length < residue) selected.push(candidate);
  }
  // Poi priorità strategica, con precedenza ai luoghi condivisi in caso di parità.
  const remaining = unique.filter(x => !selected.includes(x))
    .sort((a, b) => b.candidate.priorita - a.candidate.priorita ||
      b.nodi.size - a.nodi.size || a.candidate.distanza_m - b.candidate.distanza_m);
  selected.push(...remaining.slice(0, Math.max(0, residue - selected.length)));

  console.log({ comune, nodi: results.length, limite_comunale: limite,
    residue_comunali: residue, candidati_locali_sommati: results.reduce((n,r) => n + r.candidati.length, 0),
    sovrapposizioni_rilevate: overlaps, candidati_distinti: unique.length,
    selezionati_comunali: selected.length,
    copertura_nodi: results.map(r => ({ nodo: r.nodo.id,
      candidati_selezionati_raggiungibili: selected.filter(x => x.nodi.has(r.nodo.id)).length })) });
  const errors = results.flatMap(r => r.errori);
  if (errors.length) console.log('ATTENZIONE: ricerche parziali', errors.map(e => e.categoria));
  console.log('NOTA: selezione indicativa su liste gia troncate per nodo; nessuna persistenza o validazione operativa.');
} catch (e) {
  console.error('ERRORE:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
