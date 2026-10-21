// Turentu POPBUS V2 — anteprima PIXEL-first, sola lettura.
// Fase 1: valutazione di una missione PIXEL con ciclo base->missione->base.
// Non certifica attivazione, non genera direttrici e non scrive sul database.
// La valutazione multimissione sara' integrata solo riutilizzando il motore V2.
import { pool } from '../../../db/db.js';
import { leggiContestiOpportunitaPixel } from './pixel-opportunity-adapter.js';
import { valutaRichieste, verificaQualitaRichieste } from './model.js';
import { leg } from './planner.js';
import { valutaEconomiaCiclo } from './cycle-pricing.js';
import { verificaTurnoVeicolo } from './popbus-vehicle-availability.js';

const CLASSI = ['EXPRESS', 'STANDARD', 'STANDARD_ALTA', 'STANDARD_MEDIA', 'STANDARD_BASSA', 'SAVER'];
const MAX_OPPORTUNITA = 100;
const MAX_VEICOLI = 35;
const MAX_VALUTAZIONI = 1200;
const MAX_ROUTING = 100;
const round = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const positive = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const same = (a, b) => Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 &&
  Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7;

function empty(classe) {
  return {
    classe, stato: 'nessuna_formazione', richieste_compatibili: 0,
    posti_in_formazione: 0, picco_occupazione: 0, ricavo_attuale: 0,
    ricavo_con_richiesta: null, costo_attivazione: null,
    soglia_attivazione_lorda: null, commissione_turentu: null,
    ricavo_netto_con_richiesta: null, margine_netto_con_richiesta: null,
    ricavo_mancante: null, ricavo_mancante_dopo_richiesta: null,
    posti_mancanti_stimati: null, posti_mancanti_dopo_richiesta_stimati: null,
    posti_richiesti_utente: null, soglia_raggiunta: false,
    soglia_raggiunta_attuale: false, partenza_prevista: null,
    veicolo_riferimento_id: null, richiesta_simulata_inclusa: false,
    posti_aggiuntivi_capienza: null, posti_mancanti_realizzabili_su_piano: null,
    costo_percorso_km: null, costo_avvicinamento_km: null,
    costo_ritorno_km: null, attendibilita: 'indicativa',
    pixel_opportunita_id: null, pixel_direttrice_id: null,
    tipo_ciclo: null, verifica_multimissione: false,
    simulazione_non_prenotabile: true
  };
}
function seatsEstimate(deficit, price, seats) {
  return deficit <= 0 ? 0 : price > 0 ? Math.ceil(deficit * seats / price) : null;
}
function hasLinkedAR(rows) {
  // Una gamba A/R isolata non puo' contribuire alla soglia.
  return rows.some(r => r.ar_vincolata === true || r.ar_vincolata === 'true' ||
    r.ar_group_id != null);
}
function best(a, b) {
  if (!b) return true;
  if (a.soglia_raggiunta !== b.soglia_raggiunta) return a.soglia_raggiunta;
  if (a.ricavo_mancante_dopo_richiesta !== b.ricavo_mancante_dopo_richiesta)
    return a.ricavo_mancante_dopo_richiesta < b.ricavo_mancante_dopo_richiesta;
  return a.posti_in_formazione > b.posti_in_formazione;
}
async function conflicts(client, vehicleId, start, end) {
  const { rows } = await client.query(`
    SELECT 1 FROM public.popbus_attivazioni a
    WHERE a.veicolo_id=$1 AND a.stato IN ('in_attesa_autista','confermata')
      AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza) < $3
      AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo) > $2
    UNION ALL
    SELECT 1 FROM public.corse c
    WHERE c.veicolo_id=$1 AND c.stato IN ('prenotabile','in_corso','da_attivare')
      AND c.start_datetime < $3
      AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime > $2)
    UNION ALL
    SELECT 1 FROM public.direttrici_virtuali d
    JOIN public.segmenti s ON s.direttrice_id=d.id
    WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata')
      AND d.partenza_prevista < $3
      AND NOT EXISTS (
        SELECT 1 FROM public.popbus_attivazioni a
        WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id
          AND a.stato IN ('in_attesa_autista','confermata'))
    GROUP BY d.id,d.partenza_prevista
    HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute') > $2
    LIMIT 1`, [vehicleId, new Date(start), new Date(end)]);
  return rows.length > 0;
}
export async function anteprimaFormazionePopbus(opts) {
  const startId = Number(opts?.start_node_id);
  const endId = Number(opts?.end_node_id);
  const when = new Date(opts?.start_datetime).getTime();
  const seats = Number(opts?.posti_richiesti);
  if (!positive(startId) || !positive(endId) || startId === endId ||
      !Number.isFinite(when) || when <= Date.now() ||
      !Number.isSafeInteger(seats) || seats < 1)
    throw new Error('Anteprima PIXEL: input non valido');

  const output = Object.fromEntries(CLASSI.map(c => [c, empty(c)]));
  const enabled = CLASSI.filter(c => opts?.prezzi?.[c] != null &&
    Number.isFinite(Number(opts.prezzi[c])) && Number(opts.prezzi[c]) >= 0);
  if (!enabled.length) return output;

  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Il reader ha LIMIT 1000: il sentinel impedisce troncamenti silenziosi.
    const contexts = await leggiContestiOpportunitaPixel({
      client, limit: MAX_OPPORTUNITA + 1
    });
    if (contexts.length > MAX_OPPORTUNITA)
      throw new Error('Anteprima PIXEL: troppe opportunita; introdurre filtro nel reader');

    const relevant = contexts.filter(c => {
      const s = c.plan.nodes.indexOf(startId), e = c.plan.nodes.indexOf(endId);
      return s >= 0 && e > s && c.window.end >= when - 30 * 60000 &&
        c.window.start <= when + 30 * 60000;
    });
    if (!relevant.length) {
      await client.query('COMMIT');
      return output;
    }
    const nodeIds = [...new Set(relevant.flatMap(c => c.plan.nodes))];
    const { rows: nodes } = await client.query(`
      SELECT id, ST_Y(posizione::geometry) AS lat,
             ST_X(posizione::geometry) AS lon
      FROM public.nodi_territoriali
      WHERE attivo=TRUE AND id=ANY($1::bigint[])`, [nodeIds]);
    if (nodes.length !== nodeIds.length)
      throw new Error('Anteprima PIXEL: nodi mancanti o inattivi');
    const byNode = new Map(nodes.map(n => [Number(n.id), n]));
    const { rows: vehicles } = await client.query(`
      SELECT v.id, v.driver_id, v.posti_totali, t.euro_km,
        dv.start, dv.fine, dv.manual, dv.giorni_esclusi, dv.inattivita,
        ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
        ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM public.veicolo v
      JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (
        SELECT MIN(euro_km) AS euro_km FROM public.tariffe
        WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0
      ) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
        AND COALESCE(dv.coord,v.coord) IS NOT NULL
      ORDER BY v.id LIMIT $1`, [MAX_VEICOLI + 1]);
    if (vehicles.length > MAX_VEICOLI)
      throw new Error('Anteprima PIXEL: limite veicoli; nessun risultato parziale');

    const movementCache = new Map();
    let routingCalls = 0, evaluations = 0;
    async function move(a, b) {
      if (same(a, b)) return { metres: 0, seconds: 0 };
      const key = `${a.lat},${a.lon}>${b.lat},${b.lon}`;
      if (!movementCache.has(key)) {
        if (++routingCalls > MAX_ROUTING)
          throw new Error('Anteprima PIXEL: budget routing esaurito');
        const result = await leg(a, b);
        if (!result || !Number.isFinite(Number(result.metres)) ||
            !Number.isFinite(Number(result.seconds)) ||
            Number(result.metres) < 0 || Number(result.seconds) < 0)
          throw new Error('Anteprima PIXEL: routing non valido');
        movementCache.set(key, result);
      }
      return movementCache.get(key);
    }

    // ID sintetici POSITIVI, mai persistiti. Non simulano un ID di richiesta reale.
    // Si usa un ID oltre gli ID presenti nei contesti letti, verificandone la sicurezza.
    const maxId = Math.max(0, ...contexts.flatMap(c => c.richiesta_ids.map(Number)));
    if (!Number.isSafeInteger(maxId) || maxId >= Number.MAX_SAFE_INTEGER - CLASSI.length)
      throw new Error('Anteprima PIXEL: impossibile allocare ID virtuale sicuro');

    for (const classe of enabled) {
      const price = Number(opts.prezzi[classe]);
      const syntheticId = maxId + 1 + CLASSI.indexOf(classe);
      const virtual = {
        id: syntheticId, start_node_id: startId, end_node_id: endId,
        start_datetime: new Date(when).toISOString(),
        posti_richiesti: seats, prezzo: price, classe
      };
      let selectedBest = null;
      for (const ctx of relevant) {
        const eligible = ctx.requests.filter(r => r.id !== Number(opts?.richiesta_id));
        if (hasLinkedAR(eligible)) continue; // fail-closed fino alla valutazione A/R condivisa
        const all = [...eligible, virtual];
        const evaluation = valutaRichieste(ctx.plan, all, [syntheticId], {
          departureWindow: ctx.window
        });
        if (!evaluation || evaluation.departure <= Date.now() ||
            !evaluation.requests.some(r => r.id === syntheticId)) continue;
        const selectedIds = new Set(evaluation.requests.map(r => Number(r.id)));
        const existing = eligible.filter(r => selectedIds.has(Number(r.id)));
        if (!verificaQualitaRichieste(ctx.plan, [...existing, virtual]).ok) continue;
        const origin = byNode.get(ctx.plan.nodes[0]);
        const dest = byNode.get(ctx.plan.nodes.at(-1));
        const kmMission = ctx.plan.legs.reduce((s, l) => s + Number(l.metres), 0) / 1000;
        if (!(kmMission > 0)) continue;
        for (const v of vehicles) {
          if (++evaluations > MAX_VALUTAZIONI)
            throw new Error('Anteprima PIXEL: budget valutazioni esaurito');
          const cap = Number(v.posti_totali);
          if (!Number.isSafeInteger(cap) || evaluation.peak > cap) continue;
          const approach = await move(v, origin);
          const ret = await move(dest, v);
          const busyStart = evaluation.departure - Number(approach.seconds) * 1000;
          const busyEnd = evaluation.arrival + Number(ret.seconds) * 1000;
          if (busyStart <= Date.now() ||
              !verificaTurnoVeicolo(v, busyStart, busyEnd) ||
              await conflicts(client, Number(v.id), busyStart, busyEnd)) continue;

          const km = {
            kmAvvicinamento: Number(approach.metres) / 1000,
            kmMissioni: kmMission, kmTrasferimenti: 0,
            kmRitornoBase: Number(ret.metres) / 1000,
            euroKm: Number(v.euro_km)
          };
          const existingPrices = existing.map(r => Number(r.prezzo));
          const before = valutaEconomiaCiclo({
            ...km, ricaviRichiesteEuro: existingPrices.length ? existingPrices : [0]
          });
          const after = valutaEconomiaCiclo({
            ...km, ricaviRichiesteEuro: [...existingPrices, price]
          });
          const missingBefore = Math.max(0,
            after.sogliaAttivazioneLordaEuro - before.ricavoLordoEuro);
          const missingAfter = Math.max(0,
            after.sogliaAttivazioneLordaEuro - after.ricavoLordoEuro);
          const missingSeatsBefore = seatsEstimate(missingBefore, price, seats);
          const missingSeatsAfter = seatsEstimate(missingAfter, price, seats);
          const extraCapacity = Math.max(0, cap - evaluation.peak);
          const peakBefore = Math.max(0, ...ctx.plan.legs.map((_, i) =>
            existing.reduce((n, r) => {
              const s = ctx.plan.nodes.indexOf(Number(r.start_node_id));
              const e = ctx.plan.nodes.indexOf(Number(r.end_node_id));
              return n + (s <= i && i < e ? Number(r.posti_richiesti) : 0);
            }, 0)));
          const candidate = {
            ...empty(classe), stato: 'in_formazione',
            richieste_compatibili: existing.length,
            posti_in_formazione: existing.reduce((s, r) => s + Number(r.posti_richiesti), 0),
            picco_occupazione: peakBefore,
            ricavo_attuale: before.ricavoLordoEuro,
            ricavo_con_richiesta: after.ricavoLordoEuro,
            costo_attivazione: after.costoCompletoEuro,
            soglia_attivazione_lorda: after.sogliaAttivazioneLordaEuro,
            commissione_turentu: after.commissioneTurentuEuro,
            ricavo_netto_con_richiesta: after.ricavoNettoEuro,
            margine_netto_con_richiesta: after.margineEuro,
            ricavo_mancante: round(missingBefore),
            ricavo_mancante_dopo_richiesta: round(missingAfter),
            posti_mancanti_stimati: missingSeatsBefore,
            posti_mancanti_dopo_richiesta_stimati: missingSeatsAfter,
            posti_richiesti_utente: seats,
            // La soglia economica e' un'indicazione, NON un'autorizzazione.
            soglia_raggiunta: after.economicamenteAttivabile,
            soglia_raggiunta_attuale: before.economicamenteAttivabile,
            partenza_prevista: new Date(evaluation.departure).toISOString(),
            veicolo_riferimento_id: Number(v.id),
            richiesta_simulata_inclusa: true,
            posti_aggiuntivi_capienza: extraCapacity,
            posti_mancanti_realizzabili_su_piano:
              missingSeatsAfter == null ? null : missingSeatsAfter <= extraCapacity,
            costo_percorso_km: round(kmMission),
            costo_avvicinamento_km: round(km.kmAvvicinamento),
            costo_ritorno_km: round(km.kmRitornoBase),
            pixel_opportunita_id: ctx.pixel_opportunita_id,
            pixel_direttrice_id: ctx.pixel_direttrice_id,
            tipo_ciclo: 'singola_missione',
            verifica_multimissione: false
          };
          if (best(candidate, selectedBest)) selectedBest = candidate;
        }
      }
      if (selectedBest) output[classe] = selectedBest;
    }
    await client.query('COMMIT');
    return output;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
