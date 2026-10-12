
import { pool } from '../../../db/db.js';
import { generaCandidate, valutaRichieste } from './model.js';
import { pianifica, leg } from './planner.js';

const CLASSI = ['EXPRESS', 'STANDARD', 'SAVER'];
const MAX_RICHIESTE = 200;
const MAX_CANDIDATE = 500;

const euro = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const samePoint = (a, b) => Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 && Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7;

async function movimento(a, b) {
  if (samePoint(a, b)) return { metres: 0, seconds: 0 };
  return leg(a, b);
}

function minutiRoma(t) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(t));
  return Number(parts.find(x => x.type === 'hour')?.value) * 60 + Number(parts.find(x => x.type === 'minute')?.value);
}

// Replica la regola di turno del worker V2, inclusa la sua politica
// conservativa su giorni esclusi e inattivita'.
function turno(v, a, b) {
  if ((v.giorni_esclusi || []).length || (v.inattivita || []).length) return false;
  if (v.manual) return new Date(v.start).getTime() <= a && new Date(v.fine).getTime() >= b;
  const s = minutiRoma(v.start), e = minutiRoma(v.fine);
  for (let t = a; t < b; t += 60_000) {
    const m = minutiRoma(t);
    if (!(s < e ? m >= s && m < e : s > e ? m >= s || m < e : false)) return false;
  }
  return true;
}

function normalizeClasse(classe) {
  const c = String(classe || 'STANDARD').toUpperCase();
  if (c.startsWith('STANDARD')) return 'STANDARD';
  return CLASSI.includes(c) ? c : 'STANDARD';
}

function risultatoVuoto(classe) {
  return {
    classe, stato: 'nessuna_formazione', richieste_compatibili: 0,
    posti_in_formazione: 0, picco_occupazione: 0,
    ricavo_attuale: 0, costo_attivazione: null,
    ricavo_mancante: null, posti_mancanti_stimati: null,
    soglia_raggiunta: false, partenza_prevista: null,
    veicolo_riferimento_id: null, richiesta_simulata_inclusa: false,
    attendibilita: 'indicativa'
  };
}

function formato(result) {
  return {
    classe: result.classe,
    stato: result.soglia_raggiunta ? 'soglia_economica_raggiunta' : 'in_formazione',
    richieste_compatibili: result.richieste_compatibili,
    posti_in_formazione: result.posti_in_formazione,
    picco_occupazione: result.picco_occupazione,
    ricavo_attuale: euro(result.ricavo_attuale),
    costo_attivazione: euro(result.costo_attivazione),
    ricavo_mancante: euro(Math.max(0, result.costo_attivazione - result.ricavo_attuale)),
    posti_mancanti_stimati: result.posti_mancanti_stimati,
    soglia_raggiunta: result.soglia_raggiunta,
    partenza_prevista: new Date(result.partenza_prevista).toISOString(),
    veicolo_riferimento_id: result.veicolo_riferimento_id,
    richiesta_simulata_inclusa: result.richiesta_simulata_inclusa,
    attendibilita: 'indicativa'
  };
}

/**
 * Anteprima read-only di formazioni POPBUS V2.
 *
 * @param {object} opts
 * @param {number} opts.start_node_id Nodo origine gia' risolto
 * @param {number} opts.end_node_id Nodo destinazione gia' risolto
 * @param {string|Date} opts.start_datetime Orario richiesto
 * @param {number} opts.posti_richiesti Posti nella ricerca
 * @param {object} [opts.prezzi] Prezzi totali della richiesta per classe:
 *   { EXPRESS: 100, STANDARD: 80, SAVER: 70 }. Devono essere prezzi
 *   effettivi calcolati dal pricing, NON prezzi unitari.
 * @param {number} [opts.richiesta_id] Richiesta esistente da escludere dal pool
 *
 * Il risultato non prenota posti e non garantisce l'attivazione.
 */
export async function anteprimaFormazionePopbus(opts) {
  const startId = Number(opts?.start_node_id);
  const endId = Number(opts?.end_node_id);
  const when = new Date(opts?.start_datetime).getTime();
  const posti = Number(opts?.posti_richiesti);
  if (!Number.isInteger(startId) || !Number.isInteger(endId) || startId === endId ||
      !Number.isFinite(when) || when <= Date.now() ||
      !Number.isInteger(posti) || posti <= 0) {
    throw new Error('Anteprima POPBUS: nodi, orario o posti non validi');
  }

  const output = Object.fromEntries(CLASSI.map(c => [c, risultatoVuoto(c)]));
  const { rows: existing } = await pool.query(`
    SELECT r.* FROM richieste_pop_bus r
    WHERE r.stato='in_attesa' AND r.start_datetime>NOW()
      AND r.corsa_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM popbus_attivazione_richieste ar
        WHERE ar.richiesta_id=r.id AND ar.attiva
      )
      AND r.start_datetime BETWEEN $1::timestamptz - INTERVAL '6 hours'
                               AND $1::timestamptz + INTERVAL '6 hours'
      AND ($2::int IS NULL OR r.id <> $2::int)
    ORDER BY r.start_datetime, r.id
    LIMIT 201
  `, [new Date(when), Number.isInteger(Number(opts.richiesta_id)) ? Number(opts.richiesta_id) : null]);

  if (existing.length > MAX_RICHIESTE) {
    throw new Error('Anteprima POPBUS: oltre 200 richieste; suddividere il batch');
  }

  const ids = [...new Set([startId, endId, ...existing.flatMap(r => [Number(r.start_node_id), Number(r.end_node_id)])])];
  const { rows: nodes } = await pool.query(`
    SELECT id, ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM nodi_direttrice WHERE id=ANY($1::int[])
  `, [ids]);
  const nodeMap = new Map(nodes.map(n => [Number(n.id), n]));
  if (!nodeMap.has(startId) || !nodeMap.has(endId)) {
    throw new Error('Anteprima POPBUS: nodo origine o destinazione inesistente');
  }

  const { rows: vehicles } = await pool.query(`
    SELECT v.id, v.driver_id, v.posti_totali, t.euro_km,
           dv.start, dv.fine, dv.manual, dv.giorni_esclusi, dv.inattivita,
           ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
           ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
    FROM veicolo v
    JOIN disponibilita_veicolo dv ON dv.veicolo_id=v.id
    JOIN LATERAL (
      SELECT MIN(euro_km) AS euro_km FROM tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0
    ) t ON t.euro_km IS NOT NULL
    WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
      AND COALESCE(dv.coord,v.coord) IS NOT NULL
    ORDER BY t.euro_km,v.id
  `);

  // Il matching usa i prezzi e le classi effettivamente salvati nelle richieste.
  // Non si includono richieste con prezzo non valido; la verifica dell'effettiva
  // pre-autorizzazione rimane responsabilita' del worker.
  const valid = existing.filter(r => r.prezzo != null && Number.isFinite(Number(r.prezzo)) && Number(r.prezzo) >= 0)
    .map(r => ({ ...r, classe: normalizeClasse(r.classe) }));

  for (const classe of CLASSI) {
    const price = Number(opts?.prezzi?.[classe]);
    const hasPrice = opts?.prezzi?.[classe] != null && Number.isFinite(price) && price >= 0;
    const fakeId = -1000000 - CLASSI.indexOf(classe);
    const simulation = hasPrice ? {
      id: fakeId, start_node_id: startId, end_node_id: endId,
      start_datetime: new Date(when).toISOString(),
      posti_richiesti: posti, prezzo: price, classe
    } : null;

    const relevant = valid.filter(r => r.classe === classe);
    // L'anteprima senza prezzo corrente non puo' calcolare la compatibilita'
    // economica di una nuova prenotazione: non mostra un numero ingannevole.
    if (!simulation) continue;
    const batch = [...relevant, simulation];
    let candidates;
    try { candidates = generaCandidate(batch, MAX_CANDIDATE); }
    catch (err) { throw new Error(`Anteprima ${classe}: ${err.message}`); }

    let best = null;
    for (const candidate of candidates) {
      if (!candidate.seeds.includes(fakeId)) continue;
      let plan;
      try { plan = await pianifica(candidate, nodes); }
      catch { continue; }
      const evaluation = valutaRichieste(plan, batch, candidate.seeds);
      if (!evaluation || evaluation.departure <= Date.now()) continue;
      if (!evaluation.requests.some(r => r.id === fakeId)) continue;

      const requestIds = new Set(evaluation.requests.map(r => r.id));
      const formation = relevant.filter(r => requestIds.has(Number(r.id)));
      const existingRevenue = formation.reduce((sum, r) => sum + Math.round(Number(r.prezzo) * 100), 0) / 100;
      const totalRevenue = Number(evaluation.revenue);
      const occupiedExisting = plan.legs.map(() => 0);
      const indexes = new Map(plan.nodes.map((id, i) => [Number(id), i]));
      for (const r of formation) {
        const s = indexes.get(Number(r.start_node_id));
        const e = indexes.get(Number(r.end_node_id));
        if (s == null || e == null) continue;
        for (let i = s; i < e; i++) occupiedExisting[i] += Number(r.posti_richiesti);
      }
      const peakExisting = Math.max(0, ...occupiedExisting);
      const seatsExisting = formation.reduce((sum, r) => sum + Number(r.posti_richiesti), 0);
      const metres = plan.legs.reduce((sum, l) => sum + l.metres, 0);
      for (const v of vehicles) {
        if (Number(v.posti_totali) < evaluation.peak) continue;
        let approach, returnTrip;
        try {
          approach = await movimento(v, nodeMap.get(plan.nodes[0]));
          returnTrip = await movimento(nodeMap.get(plan.nodes.at(-1)), v);
        } catch { continue; }
        const busyStart = evaluation.departure - approach.seconds * 1000;
        const busyEnd = evaluation.arrival + returnTrip.seconds * 1000;
        if (busyStart <= Date.now() || !turno(v, busyStart, busyEnd)) continue;
        const cost = Math.ceil((metres + approach.metres + returnTrip.metres) / 1000 * Number(v.euro_km) * 100) / 100;
        // Si stima il numero di ulteriori posti usando il prezzo per posto
        // della richiesta corrente, senza confonderlo con una soglia certa.
        const unitPrice = price / posti;
        const missingRevenue = Math.max(0, cost - totalRevenue);
        const missingSeats = missingRevenue <= 0 ? 0 : unitPrice > 0 ? Math.ceil((missingRevenue - 1e-9) / unitPrice) : null;
        const candidateResult = {
          classe, richieste_compatibili: formation.length,
          posti_in_formazione: seatsExisting, picco_occupazione: peakExisting,
          ricavo_attuale: existingRevenue, costo_attivazione: cost,
          posti_mancanti_stimati: missingSeats,
          soglia_raggiunta: totalRevenue >= cost,
          partenza_prevista: evaluation.departure,
          veicolo_riferimento_id: Number(v.id),
          richiesta_simulata_inclusa: true,
          _deficitDopo: missingRevenue,
          _conNuovaRichiesta: totalRevenue
        };
        // Preferisci la formazione con piu' posti gia' presenti;
        // a parita', il deficit economico minore e il costo inferiore.
        if (!best || candidateResult.posti_in_formazione > best.posti_in_formazione ||
          (candidateResult.posti_in_formazione === best.posti_in_formazione && candidateResult._deficitDopo < best._deficitDopo) ||
          (candidateResult.posti_in_formazione === best.posti_in_formazione && candidateResult._deficitDopo === best._deficitDopo && candidateResult.costo_attivazione < best.costo_attivazione)) {
          best = candidateResult;
        }
      }
    }
    if (best) {
      output[classe] = {
        ...formato(best),
        ricavo_con_richiesta: euro(best._conNuovaRichiesta),
        ricavo_mancante_dopo_richiesta: euro(best._deficitDopo),
        posti_richiesti_utente: posti,
        // Indicatore economico: non sommare questi posti al picco occupazione.
        posti_mancanti_dopo_richiesta_stimati: best.posti_mancanti_stimati
      };
      // Ricavo mancante attuale prima della richiesta simulata.
      output[classe].ricavo_mancante = euro(Math.max(0, best.costo_attivazione - best.ricavo_attuale));
      const unit = price / posti;
      output[classe].posti_mancanti_stimati = output[classe].ricavo_mancante === 0 ? 0 : unit > 0 ? Math.ceil((output[classe].ricavo_mancante - 1e-9) / unit) : null;
    }
  }
  return output;
}
