TURENTU POPBUS V2 - SEQUENZIAMENTO SHADOW
File sorgenti e test (non certificato LIVE)


==============================================================================
FILE: turentu-stop-sequencing/popbus-stop-evaluator.service.js
==============================================================================


import { costruisciSequenzaFermate } from './popbus-stop-itinerary.service.js';
import { calcolaRoutingFermate } from './popbus-stop-routing.service.js';
import { verificaCompatibilitaTemporaleFermate } from './popbus-stop-temporal.service.js';
import { verificaQualitaFermate } from './popbus-stop-quality.service.js';
import { generaSequenzeStradaliFermate } from './popbus-stop-sequencer.service.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_EVALUATOR: ${message}`);
};

export async function valutaCombinazioniFermate({
  combinazioni,
  richieste,
  postiTotali,
  departure,
  routing,
  maxValutazioni = 100,
  maxSequenzePerCombinazione = 3,
  maxPermutazioniSequenza = 1000
}) {
  if (!Array.isArray(combinazioni) || !combinazioni.length) {
    fail('combinazioni non valide');
  }

  if (!Array.isArray(richieste) || !richieste.length) {
    fail('richieste non valide');
  }

  if (!Number.isSafeInteger(postiTotali) || postiTotali < 1) {
    fail('postiTotali non valido');
  }

  if (!Number.isFinite(departure)) {
    fail('departure non valido');
  }

  if (!Number.isSafeInteger(maxValutazioni) ||
      maxValutazioni < 1 ||
      maxValutazioni > 1000) {
    fail('maxValutazioni non valido');
  }

  const byId = new Map();

  for (const richiesta of richieste) {
    const id = Number(richiesta.id);
    const posti = Number(richiesta.posti_richiesti);

    if (!Number.isSafeInteger(id) || id <= 0 ||
        byId.has(id) ||
        !Number.isSafeInteger(posti) || posti <= 0) {
      fail('richiesta non valida o duplicata');
    }

    byId.set(id, richiesta);
  }

  const valide = [];
  const scartate = [];
  const daValutare = combinazioni.slice(0, maxValutazioni);

  for (let i = 0; i < daValutare.length; i++) {
    const combinazione = daValutare[i];

    try {
      if (!Array.isArray(combinazione.assegnazioni) ||
          combinazione.assegnazioni.length !== byId.size) {
        fail('assegnazioni incomplete');
      }

      const viste = new Set();

      const assegnazioni = combinazione.assegnazioni.map(a => {
        const id = Number(a.richiesta_id);
        const richiesta = byId.get(id);

        if (!richiesta || viste.has(id)) {
          fail('richiesta mancante o duplicata');
        }

        viste.add(id);

        return {
          ...a,
          posti_richiesti: Number(richiesta.posti_richiesti)
        };
      });

      const sequenza = costruisciSequenzaFermate({
        assegnazioni,
        postiTotali
      });

      if (!sequenza.ok) {
        scartate.push({
          indice: i,
          fase: 'SEQUENZA',
          motivo: sequenza.motivo ?? 'NON_AMMISSIBILE'
        });
        continue;
      }

      const stradali = await generaSequenzeStradaliFermate({
        sequenza,
        ...(routing ? { routing } : {}),
        maxSequenze: maxSequenzePerCombinazione,
        maxPermutazioni: maxPermutazioniSequenza
      });
      if (!stradali.ok || !stradali.sequenze.length) {
        scartate.push({ indice: i, fase: 'SEQUENZIAMENTO',
          motivo: stradali.motivo || 'NESSUNA_SEQUENZA_AMMISSIBILE' });
        continue;
      }
      for (let j = 0; j < stradali.sequenze.length; j++) {
        const sequenzaStradale = stradali.sequenze[j].sequenza;
        try {
          const itinerario = await calcolaRoutingFermate({
            sequenza: sequenzaStradale,
            departure,
            ...(routing ? { routing } : {})
          });
          if (!itinerario.ok) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'ROUTING',
              motivo: itinerario.motivo ?? 'NON_AMMISSIBILE' });
            continue;
          }
          const temporale = verificaCompatibilitaTemporaleFermate({ itinerario, richieste });
          if (!temporale.ok) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'TEMPORALE',
              motivo: temporale.motivo, richiestaId: temporale.richiestaId });
            continue;
          }
          const qualita = verificaQualitaFermate({ itinerario, richieste });
          if (!qualita.ok) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'QUALITA',
              motivo: qualita.motivo ?? 'NON_CONFORME', richiestaId: qualita.richiestaId ?? null });
            continue;
          }
          valide.push({ indice: i, sequenzaIndice: j, combinazione,
            sequenza: sequenzaStradale, itinerario, temporale, qualita,
            sequenziamento: stradali.diagnostica,
            kmMissione: itinerario.kmTotali,
            stato: 'DA_VALIDARE_ECONOMIA', attivabile: false });
        } catch (error) {
          scartate.push({ indice: i, sequenzaIndice: j, fase: 'ERRORE_SEQUENZA',
            motivo: error.message });
        }
      }
    } catch (error) {
      scartate.push({
        indice: i,
        fase: 'ERRORE',
        motivo: error.message
      });
    }
  }

  // Ordinamento provvisorio:
  // nessuna pretesa di ottimizzazione economica.
  valide.sort((a, b) =>
    a.kmMissione - b.kmMissione ||
    a.combinazione.scorePreliminare -
      b.combinazione.scorePreliminare
  );

  return {
    ok: true,
    stato: 'VALUTAZIONE_PRELIMINARE',
    valide,
    scartate,
    diagnostica: {
      combinazioniRicevute: combinazioni.length,
      combinazioniValutate: daValutare.length,
      combinazioniNonValutate:
        combinazioni.length - daValutare.length,
      preliminarmenteValide: valide.length,
      scartate: scartate.length,
      valutazioneCompleta:
        combinazioni.length <= maxValutazioni,
      sequenziamentoEsaustivo: valide.every(v => v.sequenziamento.ricercaEsaustiva)
    },
    attivabile: false
  };
}


==============================================================================
FILE: turentu-stop-sequencing/test-stop-sequencer.mjs
==============================================================================

import assert from 'node:assert/strict';
import { generaSequenzeStradaliFermate } from './popbus-stop-sequencer.service.js';
const stop = (id, indice, lat) => ({ visita_id:id, fermata_id:id, indiceTerritoriale:indice,
  lat, lon:18, eventi:[{ richiesta_id:id, tipo:'salita', posti:1 }, { richiesta_id:id, tipo:'discesa', posti:1 }] });
// Eventi salita/discesa nella stessa visita sono intenzionalmente non validi:
// la verifica richiede discese di richieste già salite in visite precedenti.
const visite = [
  { ...stop(90,0,0), eventi:[{richiesta_id:1,tipo:'salita',posti:1}] },
  { ...stop(80,1,3), eventi:[{richiesta_id:2,tipo:'salita',posti:1}] },
  { ...stop(12,1,1), eventi:[{richiesta_id:1,tipo:'discesa',posti:1}] },
  { ...stop(45,1,2), eventi:[{richiesta_id:2,tipo:'discesa',posti:1}] }
];
const seq = { ok:true, visite, postiTotali:2 };
const routing = async (a,b) => ({ metres:Math.abs(a.lat-b.lat)*1000, seconds:Math.abs(a.lat-b.lat)*60, polyline:'fake' });
const r = await generaSequenzeStradaliFermate({sequenza:seq,routing,maxSequenze:10});
assert.equal(r.ok,true);
assert.equal(r.sequenze[0].sequenza.visite.map(x=>x.fermata_id).join(','),'90,12,80,45');
assert.equal(r.sequenze[0].metriStradali,4000);
assert.equal(r.sequenze[0].sequenza.peak,1);
assert.equal(r.sequenze.every(x=>x.sequenza.attivabile===false),true);
const limited = await generaSequenzeStradaliFermate({sequenza:seq,routing,maxPermutazioni:2});
assert.equal(limited.ok,false);
assert.equal(limited.motivo,'RICERCA_INCOMPLETA');
console.log('OK: ordine stradale, precedenze, capienza, SHADOW, budget');


==============================================================================
FILE: turentu-stop-sequencing/popbus-stop-sequencer.service.js
==============================================================================

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
    peak, postiTotali, routingVerificato: false, qualitaVerificata: false, attivabile: false };
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
  for (const visits of frontier) {
    const candidate = verificaEventi(visits, sequenza.postiTotali);
    if (!candidate) continue;
    let metres = 0;
    let seconds = 0;
    let valid = true;
    for (let i = 1; i < visits.length; i++) {
      const a = visits[i - 1], b = visits[i];
      if (samePoint(a, b)) continue;
      const k = `${a.lat},${a.lon}>${b.lat},${b.lon}`;
      if (!legCache.has(k)) {
        try { legCache.set(k, await routing(a, b)); }
        catch { legCache.set(k, null); }
      }
      const l = legCache.get(k);
      const normal = Number.isFinite(Number(l?.metres)) && Number(l.metres) > 0 &&
        Number.isFinite(Number(l?.seconds)) && Number(l.seconds) > 0 &&
        typeof l?.polyline === 'string' && l.polyline.length > 0;
      const coincident = l?.roadCoincident === true && l.metres === 0 && l.seconds === 0;
      if (!normal && !coincident) { valid = false; break; }
      metres += Number(l.metres);
      seconds += Number(l.seconds);
    }
    if (valid) feasible.push({ sequenza: candidate, metriStradali: metres, secondiStradali: seconds });
  }
  feasible.sort((a, b) => a.metriStradali - b.metriStradali ||
    a.secondiStradali - b.secondiStradali ||
    a.sequenza.visite.map(v => v.fermata_id).join(':').localeCompare(
      b.sequenza.visite.map(v => v.fermata_id).join(':')));
  return { ok: true, stato: 'SEQUENZE_STRADALI_PRELIMINARI',
    sequenze: feasible.slice(0, maxSequenze),
    diagnostica: { ricercaEsaustiva: feasible.length <= maxSequenze,
      permutazioniEsaminate: examined, sequenzeAmmissibili: feasible.length,
      sequenzeRestituite: Math.min(maxSequenze, feasible.length) }, attivabile: false };
}


==============================================================================
FILE: turentu-stop-sequencing/README.txt
==============================================================================

TURENTU POPBUS V2 — sequenziamento stradale SHADOW

INSTALLAZIONE:
1. Copiare popbus-stop-sequencer.service.js in services/popbus/v2/ (nuovo file).
2. Sostituire services/popbus/v2/popbus-stop-evaluator.service.js con il file allegato,
   dopo aver confrontato la versione locale: deriva dal file caricato in chat
   popbus-stop-evaluator.service(6).js.
3. Non copiare test-stop-sequencer.mjs nella cartella dei servizi: e' un test isolato.

COMPATIBILITA':
- La funzione di valutazione mantiene la firma e il risultato esistenti;
  aggiunge maxSequenzePerCombinazione e maxPermutazioniSequenza opzionali.
- Sequenze ordinate all'interno di ciascun indice territoriale.
- Ogni alternativa e' validata da routing, temporalita' e qualita' esistenti.
- Ricerca troncata => RICERCA_INCOMPLETA, nessuna alternativa restituita.
- Se il limite maxSequenzePerCombinazione taglia le alternative, diagnostica
  ricercaEsaustiva=false; l'assenza di risultati non prova l'impossibilita'.
- Nessuna scrittura DB; attivabile:false.

LIMITI DELLA PRIMA FASE:
- Non ottimizza la partenza o le attese.
- Non certifica economia del ciclo o attivazione LIVE.
- I gruppi con piu' di 5 visite vengono scartati con diagnostica.
- Per ogni combinazione si valutano al massimo 3 sequenze stradali:
  una sequenza scartata per qualita'/tempo potrebbe essere sostituita da
  un'alternativa oltre il limite; questo e' diagnostico, non certificativo.
- Il routing di prova del test e' sintetico, non verifica provider esterni.


==============================================================================
FILE: test-diagnostica.mjs
==============================================================================

import assert from 'node:assert/strict';
import { generaSequenzeStradaliFermate as sequence } from './popbus-stop-sequencer.service.js';
const evt=(id,tipo)=>({richiesta_id:id,tipo,posti:1});
const v=(id,idx,x,eventi)=>({visita_id:id,fermata_id:id,indiceTerritoriale:idx,lat:x,lon:18,eventi});
const route=async(a,b)=>({metres:Math.abs(a.lat-b.lat)*1000,seconds:Math.abs(a.lat-b.lat)*60,polyline:'mock'});
const cases=[];
const normal={ok:true,postiTotali:2,visite:[v(90,0,0,[evt(1,'salita')]),v(12,1,1,[evt(1,'discesa')]),v(45,1,2,[evt(2,'discesa')]),v(80,1,3,[evt(2,'salita')])]};
// Input from the original itinerary is always validated; this synthetic sequence tests the sequencer's ability to reorder.
let r=await sequence({sequenza:normal,routing:route,maxSequenze:10});
assert.equal(r.ok,true);assert.equal(r.sequenze[0].sequenza.visite.map(x=>x.fermata_id).join(','),'90,12,80,45');
cases.push(['riordino stradale e precedenze','PASS']);
const two={ok:true,postiTotali:2,visite:[v(1,0,0,[evt(1,'salita')]),v(2,1,1,[evt(1,'discesa')])]};
r=await sequence({sequenza:two,routing:route});assert.equal(r.ok,true);assert.equal(r.sequenze.length,1);cases.push(['percorso minimo','PASS']);
const budget=await sequence({sequenza:normal,routing:route,maxPermutazioni:2});assert.equal(budget.motivo,'RICERCA_INCOMPLETA');cases.push(['budget e fail-closed','PASS']);
const many={ok:true,postiTotali:6,visite:[v(1,0,0,[evt(1,'salita')]),...Array.from({length:6},(_,i)=>v(10+i,1,i+1,[evt(1,'discesa'),evt(2,'salita')].filter((_,j)=>i===0?j===0:i===1?j===1:false)))]};
// Avoid empty event visits: each has an independent boarding/dropoff event instead.
many.visite=[v(1,0,0,[evt(1,'salita')]),...Array.from({length:6},(_,i)=>v(10+i,1,i+1,[evt(i+2,'salita')])),...Array.from({length:7},(_,i)=>v(20+i,2,i+8,[evt(i+1,'discesa')]))];
r=await sequence({sequenza:many,routing:route});assert.equal(r.motivo,'GRUPPO_TROPPO_GRANDE');cases.push(['gruppi > 5: non supportati','LIMITAZIONE']);
const crowded={ok:true,postiTotali:1,visite:[v(1,0,0,[evt(1,'salita')]),v(2,1,1,[evt(2,'salita')]),v(3,2,2,[evt(1,'discesa'),evt(2,'discesa')])]};
r=await sequence({sequenza:crowded,routing:route});assert.equal(r.sequenze.length,0);cases.push(['capienza oltre limite','PASS']);
console.table(cases);
