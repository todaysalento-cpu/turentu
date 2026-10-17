
import { pool } from '../../../db/db.js';
import { generaCandidate, generaFormazioniAlternative } from './model.js';
import { pianifica, leg } from './planner.js';
import { valutaEconomiaCiclo } from './cycle-pricing.js';

// Le classi sono distinte: STANDARD_* non viene mai convertita in STANDARD.
const CLASSI = ['EXPRESS', 'STANDARD', 'STANDARD_ALTA', 'STANDARD_MEDIA', 'STANDARD_BASSA', 'SAVER'];
const MAX_RICHIESTE = 200;
const MAX_CANDIDATE = 500;
const MAX_FORMAZIONI_PER_PIANO = 100;
const EPS = 1e-8;

const euro = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cents = n => Math.round(Number(n) * 100);
const num = n => Number(n);
const validClass = c => CLASSI.includes(String(c || '').trim().toUpperCase())
    ? String(c).trim().toUpperCase() : null;
const samePoint = (a, b) =>
    Math.abs(num(a.lat) - num(b.lat)) < 1e-7 &&
    Math.abs(num(a.lon) - num(b.lon)) < 1e-7;

async function movimento(a, b) {
    if (samePoint(a, b)) return { metres: 0, seconds: 0 };
    return leg(a, b);
}

function minutiRoma(t) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(t));
    return num(parts.find(p => p.type === 'hour')?.value) * 60 +
        num(parts.find(p => p.type === 'minute')?.value);
}

// Stessa politica conservativa del file originale.
function turno(v, a, b) {
    if ((v.giorni_esclusi || []).length || (v.inattivita || []).length) return false;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) return false;
    if (v.manual) {
        return new Date(v.start).getTime() <= a && new Date(v.fine).getTime() >= b;
    }
    const s = minutiRoma(v.start), e = minutiRoma(v.fine);
    if (s === e) return false;
    for (let t = a; t < b; t += 60_000) {
        const m = minutiRoma(t);
        if (!(s < e ? m >= s && m < e : m >= s || m < e)) return false;
    }
    return true;
}

function vuoto(classe) {
    return {
        classe, stato: 'nessuna_formazione', richieste_compatibili: 0,
        posti_in_formazione: 0, picco_occupazione: 0,
        ricavo_attuale: 0, ricavo_con_richiesta: null,
        costo_attivazione: null, soglia_attivazione_lorda: null,
         commissione_turentu: null, ricavo_netto_con_richiesta: null,
         margine_netto_con_richiesta: null, ricavo_mancante: null,
        ricavo_mancante_dopo_richiesta: null,
        posti_mancanti_stimati: null,
        posti_mancanti_dopo_richiesta_stimati: null,
        posti_richiesti_utente: null, soglia_raggiunta: false,
        soglia_raggiunta_attuale: false, partenza_prevista: null,
        veicolo_riferimento_id: null, richiesta_simulata_inclusa: false,
        posti_aggiuntivi_capienza: null, posti_mancanti_realizzabili_su_piano: null,
        costo_percorso_km: null, costo_avvicinamento_km: null,
        costo_ritorno_km: null, attendibilita: 'indicativa'
    };
}

function stimaPosti(deficitCentesimi, prezzoCentesimi, postiRichiesti) {
    if (deficitCentesimi <= 0) return 0;
    if (prezzoCentesimi <= 0 || postiRichiesti <= 0) return null;
    // Stima economica: ogni posto aggiuntivo rende quanto il prezzo medio
    // della richiesta simulata. Non equivale a capienza disponibile.
    return Math.ceil((deficitCentesimi * postiRichiesti) / prezzoCentesimi - EPS);
}

function migliore(a, b) {
    if (!b) return true;
    // Prima un piano che copre i costi NETTI, poi il deficit lordo minore.
    if (a.soglia_raggiunta !== b.soglia_raggiunta) return a.soglia_raggiunta;
    if (a._deficitDopo !== b._deficitDopo) return a._deficitDopo < b._deficitDopo;
    if (a.posti_in_formazione !== b.posti_in_formazione)
        return a.posti_in_formazione > b.posti_in_formazione;
    if (a.costo_attivazione !== b.costo_attivazione)
        return a.costo_attivazione < b.costo_attivazione;
    return a.veicolo_riferimento_id < b.veicolo_riferimento_id;
}

/**
 * Anteprima read-only POPBUS V2. Non crea corse, non riserva posti e non
 * certifica preautorizzazioni o assenza di conflitti con corse esistenti.
 * prezzi: importi TOTALI della richiesta, indicizzati per classe.
 * Le classi STANDARD_* sono indipendenti dalla classe STANDARD.
 */
export async function anteprimaFormazionePopbus(opts) {
    const startId = num(opts?.start_node_id);
    const endId = num(opts?.end_node_id);
    const when = new Date(opts?.start_datetime).getTime();
    const posti = num(opts?.posti_richiesti);
    if (!Number.isSafeInteger(startId) || !Number.isSafeInteger(endId) || startId <= 0 ||
        endId <= 0 || startId === endId || !Number.isFinite(when) ||
        when <= Date.now() || !Number.isInteger(posti) || posti <= 0) {
        throw new Error('Anteprima POPBUS: nodi, orario o posti non validi');
    }

    const output = Object.fromEntries(CLASSI.map(c => [c, vuoto(c)]));
    const excluded = opts?.richiesta_id == null ? null : num(opts.richiesta_id);
    if (excluded !== null && !Number.isSafeInteger(excluded))
        throw new Error('Anteprima POPBUS: richiesta_id non valido');

    // Conservata la stessa query della versione ricevuta: verificare che
    // popbus_attivazione_richieste.attiva esista nello schema reale.
    const { rows: existing } = await pool.query(`
        SELECT r.* FROM richieste_pop_bus r
        WHERE r.stato = 'in_attesa' AND r.start_datetime > NOW()
          AND r.corsa_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM popbus_attivazione_richieste ar
              WHERE ar.richiesta_id = r.id AND ar.attiva
          )
          AND r.start_datetime BETWEEN $1::timestamptz - INTERVAL '6 hours'
                                   AND $1::timestamptz + INTERVAL '6 hours'
          AND ($2::int IS NULL OR r.id <> $2::int)
        ORDER BY r.start_datetime, r.id
        LIMIT 201
    `, [new Date(when), excluded]);
    if (existing.length > MAX_RICHIESTE)
        throw new Error('Anteprima POPBUS: oltre 200 richieste; suddividere il batch');

    const valid = existing.filter(r => {
        const c = validClass(r.classe || 'STANDARD');
        const p = num(r.prezzo), n = num(r.posti_richiesti);
        return c && r.prezzo != null && Number.isFinite(p) && p >= 0 &&
            Number.isInteger(n) && n > 0 &&
            Number.isSafeInteger(num(r.start_node_id)) &&
            Number.isSafeInteger(num(r.end_node_id)) &&
            num(r.start_node_id) !== num(r.end_node_id);
    }).map(r => ({ ...r, classe: validClass(r.classe || 'STANDARD') }));

    const ids = [...new Set([startId, endId,
        ...valid.flatMap(r => [num(r.start_node_id), num(r.end_node_id)])])];
    const { rows: nodes } = await pool.query(`
        SELECT id, ST_Y(posizione::geometry) AS lat,
               ST_X(posizione::geometry) AS lon
        FROM nodi_territoriali WHERE id = ANY($1::bigint[])
    `, [ids]);
    // PostgreSQL bigint viene restituito come stringa da pg: usare Number
    // soltanto quando l'identificativo e' rappresentabile senza perdita.
    if (nodes.some(n => !Number.isSafeInteger(num(n.id))))
        throw new Error('Anteprima POPBUS: ID nodo territoriale fuori intervallo sicuro JavaScript');
    const nodeMap = new Map(nodes.map(n => [num(n.id), n]));
    if (!nodeMap.has(startId) || !nodeMap.has(endId))
        throw new Error('Anteprima POPBUS: nodo origine o destinazione inesistente');
    if (valid.some(r => !nodeMap.has(num(r.start_node_id)) || !nodeMap.has(num(r.end_node_id))))
        throw new Error('Anteprima POPBUS: richieste con nodi territoriali mancanti');

    const { rows: vehicles } = await pool.query(`
        SELECT v.id, v.driver_id, v.posti_totali, t.euro_km,
               dv.start, dv.fine, dv.manual, dv.giorni_esclusi, dv.inattivita,
               ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
               ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
        FROM veicolo v
        JOIN disponibilita_veicolo dv ON dv.veicolo_id = v.id
        JOIN LATERAL (
            SELECT MIN(euro_km) AS euro_km FROM tariffe
            WHERE veicolo_id = v.id AND tipo = 'standard' AND euro_km > 0
        ) t ON t.euro_km IS NOT NULL
        WHERE v.driver_id IS NOT NULL AND v.posti_totali > 0
          AND COALESCE(dv.coord,v.coord) IS NOT NULL
        ORDER BY t.euro_km, v.id
    `);

    // Cache locale alla singola ricerca: niente dati condivisi tra richieste.
    const movementCache = new Map();
    async function cachedMove(a, b) {
        const key = `${num(a.lat)},${num(a.lon)}|${num(b.lat)},${num(b.lon)}`;
        if (!movementCache.has(key)) movementCache.set(key, movimento(a, b));
        return movementCache.get(key);
    }

    for (let ci = 0; ci < CLASSI.length; ci++) {
        const classe = CLASSI[ci];
        if (opts?.prezzi?.[classe] == null) continue;
        const price = num(opts.prezzi[classe]);
        if (!Number.isFinite(price) || price < 0) continue;
        const fakeId = -1000000 - ci;
        const simulation = {
            id: fakeId, start_node_id: startId, end_node_id: endId,
            start_datetime: new Date(when).toISOString(),
            posti_richiesti: posti, prezzo: price, classe
        };
        const relevant = valid.filter(r => r.classe === classe);
        const batch = [...relevant, simulation];
        let candidates;
        try {
            candidates = generaCandidate(batch, MAX_CANDIDATE);
        } catch (err) {
            throw new Error(`Anteprima ${classe}: ${err.message}`);
        }

        let best = null;
        const viste = new Set();
        let formazioniValutate = 0;
        for (const candidate of candidates) {
            if (!candidate.seeds.includes(fakeId)) continue;
            let plan;
            try { plan = await pianifica(candidate, nodes); }
            catch { continue; }
            if (!plan?.legs?.length || !plan?.nodes?.length) continue;
            // La richiesta simulata è obbligatoria, ma le altre
            // richieste possono essere distribuite tra veicoli diversi.
            const alternatives = generaFormazioniAlternative(
                plan, batch, candidate.seeds,
                { maxFormazioni: MAX_FORMAZIONI_PER_PIANO }
            );
            for (const evaluation of alternatives) {
                if (evaluation.departure <= Date.now()) continue;
                if (!evaluation.requests.some(r => num(r.id) === fakeId)) continue;
                const signature = `${classe}|${plan.nodes.join(':')}|${evaluation.requests
                    .map(r => r.id).sort((a, b) => a - b).join(',')}|${evaluation.departure}`;
                if (viste.has(signature)) continue;
                viste.add(signature);
                formazioniValutate++;

            const selected = new Set(evaluation.requests.map(r => num(r.id)));
            const formation = relevant.filter(r => selected.has(num(r.id)));
            const existingCents = formation.reduce((s, r) => s + cents(r.prezzo), 0);
            const totalCents = existingCents + cents(price);
            const indexes = new Map(plan.nodes.map((id, i) => [num(id), i]));
            const occupiedExisting = plan.legs.map(() => 0);
            for (const r of formation) {
                const s = indexes.get(num(r.start_node_id));
                const e = indexes.get(num(r.end_node_id));
                if (s == null || e == null || s >= e) continue;
                for (let i = s; i < e; i++) occupiedExisting[i] += num(r.posti_richiesti);
            }
            const peakExisting = Math.max(0, ...occupiedExisting);
            const seatsExisting = formation.reduce((s, r) => s + num(r.posti_richiesti), 0);
            const metres = plan.legs.reduce((s, l) => s + num(l.metres), 0);
            if (!Number.isFinite(metres) || metres <= 0) continue;
            const origin = nodeMap.get(num(plan.nodes[0]));
            const destination = nodeMap.get(num(plan.nodes.at(-1)));
            if (!origin || !destination) continue;

            for (const v of vehicles) {
                const cap = num(v.posti_totali);

                // DIAGNOSTICA: verifica perché un veicolo viene escluso
                // dalla formazione e confronta tariffa e picco occupazione.
                console.log('[POPBUS VEHICLE CHECK]', {
                    classe,
                    veicolo_id: num(v.id),
                    posti_totali: cap,
                    picco_richiesto: num(evaluation.peak),
                    tariffa_km: num(v.euro_km),
                    escluso_per_capienza:
                        !Number.isInteger(cap) || cap < evaluation.peak
                });

                if (!Number.isInteger(cap) || cap < evaluation.peak) continue;
                let approach, returnTrip;
                try {
                    [approach, returnTrip] = await Promise.all([
                        cachedMove(v, origin), cachedMove(destination, v)
                    ]);
                } catch { continue; }
                if (![approach.metres, approach.seconds, returnTrip.metres, returnTrip.seconds]
                    .every(n => Number.isFinite(num(n)) && num(n) >= 0)) continue;
                const busyStart = evaluation.departure - num(approach.seconds) * 1000;
                const busyEnd = evaluation.arrival + num(returnTrip.seconds) * 1000;
                if (busyStart <= Date.now() || !turno(v, busyStart, busyEnd)) continue;

                                 // Pricing condiviso: lordo delle richieste, commissione 15%,
                 // avvicinamento, missione e ritorno. Nessuna attesa tra
                 // missioni in questa anteprima a singola formazione.
                 // Stessa geometria/costo per scenario attuale e simulato.
                 let before, after;
                 const km = {
                     kmAvvicinamento: num(approach.metres) / 1000,
                     kmMissioni: metres / 1000,
                     kmTrasferimenti: 0,
                     kmRitornoBase: num(returnTrip.metres) / 1000,
                     euroKm: num(v.euro_km)
                 };
                 try {
                     before = valutaEconomiaCiclo({
                         ...km, ricaviRichiesteEuro: formation.length
                             ? formation.map(r => num(r.prezzo)) : [0]
                     });
                     after = valutaEconomiaCiclo({
                         ...km, ricaviRichiesteEuro: [
                             ...formation.map(r => num(r.prezzo)), price
                         ]
                     });
                 } catch { continue; }
                 const thresholdCents = after.centesimi.sogliaLorda;
                 const missingBefore = Math.max(0, thresholdCents - before.centesimi.ricavoLordo);
                 const missingAfter = Math.max(0, thresholdCents - after.centesimi.ricavoLordo);
                 const missingSeatsBefore = stimaPosti(missingBefore, cents(price), posti);
                 const missingSeatsAfter = stimaPosti(missingAfter, cents(price), posti);
// Solo una stima di posti ulteriori nello stesso segmento
                // della nuova richiesta, NON capienza dell'intera direttrice.
                const postiAggiuntivi = Math.max(0, cap - evaluation.peak);
                const candidateResult = {
                    classe, richieste_compatibili: formation.length,
                    posti_in_formazione: seatsExisting, picco_occupazione: peakExisting,
                    ricavo_attuale: existingCents / 100,
                    ricavo_con_richiesta: totalCents / 100,
                    costo_attivazione: after.costoCompletoEuro,
                     soglia_attivazione_lorda: after.sogliaAttivazioneLordaEuro,
                     commissione_turentu: after.commissioneTurentuEuro,
                     ricavo_netto_con_richiesta: after.ricavoNettoEuro,
                     margine_netto_con_richiesta: after.margineEuro,
                    ricavo_mancante: missingBefore / 100,
                    ricavo_mancante_dopo_richiesta: missingAfter / 100,
                    posti_mancanti_stimati: missingSeatsBefore,
                    posti_mancanti_dopo_richiesta_stimati: missingSeatsAfter,
                    posti_richiesti_utente: posti,
                    soglia_raggiunta: after.economicamenteAttivabile,
                    soglia_raggiunta_attuale: before.economicamenteAttivabile,
                    partenza_prevista: new Date(evaluation.departure).toISOString(),
                    veicolo_riferimento_id: num(v.id),
                    richiesta_simulata_inclusa: true,
                    posti_aggiuntivi_capienza: postiAggiuntivi,
                    posti_mancanti_realizzabili_su_piano:
                        missingSeatsAfter == null ? null : missingSeatsAfter <= postiAggiuntivi,
                    costo_percorso_km: euro(metres / 1000),
                    costo_avvicinamento_km: euro(num(approach.metres) / 1000),
                    costo_ritorno_km: euro(num(returnTrip.metres) / 1000),
                    attendibilita: 'indicativa',
                    _deficitDopo: missingAfter
                };
                if (migliore(candidateResult, best)) best = candidateResult;
            }
            } // fine alternativa
        } // fine candidata
        console.log('[POPBUS PREVIEW MULTI-VEICOLO]', {
            classe, candidate: candidates.length,
            formazioniValutate,
            miglioreVeicolo: best?.veicolo_riferimento_id ?? null,
            deficitEuro: best ? best._deficitDopo / 100 : null
        });
        if (best) {
            const { _deficitDopo, ...publicResult } = best;
            output[classe] = {
                ...publicResult,
                stato: best.soglia_raggiunta
                    ? 'soglia_economica_raggiunta' : 'in_formazione'
            };
        }
    }
    return output;
}
