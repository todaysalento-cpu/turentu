// TURENTU POPBUS V2 — sequenziamento stradale SHADOW, senza DB writes.
// Non genera direttrici: preserva gli indici territoriali forniti da PIXEL.
import { leg } from './planner.js';

const samePoint = (a, b) =>
  Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 &&
  Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7;

function verificaEventi(visite, postiTotali) {
  let occupati = 0;
  let peak = 0;
  const aBordo = new Set();
  const result = [];
  for (const v of visite) {
    const eventi = [
      ...v.eventi.filter(e => e.tipo === 'discesa'),
      ...v.eventi.filter(e => e.tipo === 'salita')
    ];
    for (const e of eventi) {
      const id = Number(e.richiesta_id);
      const posti = Number(e.posti);
      if (!Number.isSafeInteger(id) || id <= 0 ||
          !Number.isSafeInteger(posti) || posti <= 0) return null;
      if (e.tipo === 'discesa') {
        if (!aBordo.has(id)) return null;
        aBordo.delete(id);
        occupati -= posti;
      } else if (e.tipo === 'salita') {
        if (aBordo.has(id)) return null;
        aBordo.add(id);
        occupati += posti;
      } else return null;
    }
    if (occupati < 0 || occupati > postiTotali) return null;
    peak = Math.max(peak, occupati);
    result.push({ ...v, visita_id: result.length + 1, eventi, occupatiDopoVisita: occupati });
  }
  if (aBordo.size || occupati !== 0) return null;
  return { ok: true, stato: 'SEQUENZA_STRADALE_PRELIMINARE', visite: result,
    peak, postiTotali, capienzaVerificata: true,
    routingVerificato: false, qualitaVerificata: false, attivabile: false };
}

function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    for (const tail of permutations([...items.slice(0, i), ...items.slice(i + 1)])) {
      yield [items[i], ...tail];
    }
  }
}

// Il limite è esplicito: una ricerca tagliata non può dichiararsi esaustiva.
export async function generaSequenzeStradaliFermate({
  sequenza, routing = leg, maxSequenze = 3,
  maxPermutazioni = 1000, maxVisitePerGruppo = 5
}) {
  if (!sequenza?.ok || !Array.isArray(sequenza.visite) || !sequenza.visite.length ||
      !Number.isSafeInteger(sequenza.postiTotali) || sequenza.postiTotali <= 0 ||
      typeof routing !== 'function') throw new Error('POPBUS_STOP_SEQUENCER: input non valido');
  for (const [name, value] of Object.entries({ maxSequenze, maxPermutazioni, maxVisitePerGruppo })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000)
      throw new Error(`POPBUS_STOP_SEQUENCER: ${name} non valido`);
  }
  const groups = [];
  for (const v of sequenza.visite) {
    const last = groups.at(-1);
    if (last && last[0].indiceTerritoriale === v.indiceTerritoriale) last.push(v);
    else groups.push([v]);
  }
  if (groups.some(g => g.length > maxVisitePerGruppo)) {
    return { ok: false, motivo: 'GRUPPO_TROPPO_GRANDE', sequenze: [],
      diagnostica: { ricercaEsaustiva: false, permutazioniEsaminate: 0 } };
  }
  let frontier = [[]];
  let examined = 0;
  let truncated = false;
  for (const group of groups) {
    const next = [];
    outer: for (const prefix of frontier) {
      for (const permutation of permutations(group)) {
        if (examined >= maxPermutazioni) { truncated = true; break outer; }
        examined++;
        const visits = [...prefix, ...permutation];
        // Non si possono verificare discese future prima di avere tutte le salite:
        // validiamo la sequenza completa dopo l'ultimo gruppo.
        next.push(visits);
      }
    }
    if (!next.length) break;
    frontier = next;
    if (truncated) break;
  }
  if (truncated || frontier.some(v => v.length !== sequenza.visite.length)) {
    return { ok: false, motivo: 'RICERCA_INCOMPLETA', sequenze: [],
      diagnostica: { ricercaEsaustiva: false, permutazioniEsaminate: examined } };
  }
  const feasible = [];
  const legCache = new Map();
  const diag = {
    sequenzeScartateEventi: 0,
    sequenzeScartateRouting: 0,
    routingEccezioni: 0,
    routingRisposteNonValide: 0,
    routingTratteDistinte: 0,
    campioneErroriRouting: []
  };
  const sampleRouting = (a, b, motivo) => {
    if (diag.campioneErroriRouting.length < 5) {
      diag.campioneErroriRouting.push({
        fermataDa: a.fermata_id ?? null,
        fermataA: b.fermata_id ?? null,
        motivo: String(motivo).slice(0, 240)
      });
    }
  };
  for (const visits of frontier) {
    const candidate = verificaEventi(visits, sequenza.postiTotali);
    if (!candidate) { diag.sequenzeScartateEventi++; continue; }
    let metres = 0;
    let seconds = 0;
    let valid = true;
    for (let i = 1; i < visits.length; i++) {
      const a = visits[i - 1], b = visits[i];
      if (samePoint(a, b)) continue;
      const k = `${a.lat},${a.lon}>${b.lat},${b.lon}`;
      if (!legCache.has(k)) {
        diag.routingTratteDistinte++;
        try {
          legCache.set(k, await routing(a, b));
        } catch (error) {
          diag.routingEccezioni++;
          sampleRouting(a, b, `ECCEZIONE: ${error?.message ?? String(error)}`);
          legCache.set(k, null);
        }
      }
      const l = legCache.get(k);
      const normal = Number.isFinite(Number(l?.metres)) && Number(l.metres) > 0 &&
        Number.isFinite(Number(l?.seconds)) && Number(l.seconds) > 0 &&
        typeof l?.polyline === 'string' && l.polyline.length > 0;
      const coincident = l?.roadCoincident === true && l.metres === 0 && l.seconds === 0;
      if (!normal && !coincident) {
        // Conteggio per tratta distinta, per non gonfiare il numero a causa della cache.
        if (!legCache.has(`${k}|invalid-counted`)) {
          diag.routingRisposteNonValide++;
          sampleRouting(a, b, l === null ? 'RISPOSTA_NULL_O_ECCEZIONE' :
            `RISPOSTA_NON_VALIDA metres=${String(l?.metres)} seconds=${String(l?.seconds)} polyline=${typeof l?.polyline}`);
          legCache.set(`${k}|invalid-counted`, true);
        }
        valid = false;
        break;
      }
      metres += Number(l.metres);
      seconds += Number(l.seconds);
    }
    if (valid) feasible.push({ sequenza: candidate, metriStradali: metres, secondiStradali: seconds });
    else diag.sequenzeScartateRouting++;
  }
  feasible.sort((a, b) => a.metriStradali - b.metriStradali ||
    a.secondiStradali - b.secondiStradali ||
    a.sequenza.visite.map(v => v.fermata_id).join(':').localeCompare(
      b.sequenza.visite.map(v => v.fermata_id).join(':')));
  return { ok: true, stato: 'SEQUENZE_STRADALI_PRELIMINARI',
    sequenze: feasible.slice(0, maxSequenze),
    diagnostica: { ricercaEsaustiva: true,
      outputLimitato: feasible.length > maxSequenze,
      permutazioniEsaminate: examined, sequenzeAmmissibili: feasible.length,
      sequenzeRestituite: Math.min(maxSequenze, feasible.length),
      ...diag }, attivabile: false };
}