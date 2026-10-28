// TURENTU POPBUS V2 - Valutazione economica del ciclo assemblato.
// Modulo puro e diagnostico: nessun accesso DB, nessuna autorizzazione LIVE.
import { valutaEconomiaCiclo } from './cycle-pricing.js';
import polyline from '@mapbox/polyline';

const fail = message => { throw new Error(`POPBUS_STOP_CYCLE_ECONOMICS: ${message}`); };
const idValido = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;
const numeroNonNegativo = x => x != null && x !== '' && typeof x !== 'boolean' && Number.isFinite(Number(x)) && Number(x) >= 0;
const intero = x => Number.isSafeInteger(x) && x >= 0;
const quasiUguale = (a, b) => Math.abs(a - b) <= 0.01;

function metri(tratta, nome) {
  if (!tratta || tratta.routingVerificato !== true || !numeroNonNegativo(tratta.metres))
    fail(`${nome}: routing o metri non verificati`);
  return Number(tratta.metres);
}

function legValido(l, nome, i, richiediPolyline = true) {
  if (!numeroNonNegativo(l?.metres) || !numeroNonNegativo(l?.seconds) ||
      (richiediPolyline && (typeof l.polyline !== 'string' || !l.polyline.length)) ||
      (!richiediPolyline && Number(l.metres) > 0 && (typeof l.polyline !== 'string' || !l.polyline.length)))
    fail(`${nome}: segmento ${i} non valido`);
  return Number(l.metres);
}

function sommaLegs(legs, nome, richiediPolyline = true) {
  if (!Array.isArray(legs) || !legs.length) fail(`${nome}: segmenti assenti`);
  return legs.reduce((tot, l, i) => tot + legValido(l, nome, i, richiediPolyline), 0);
}

export function valutaEconomiaCicloFermate({
  ciclo, missioni, missioniAdattate, trasferimenti = [], richieste, avvicinamento,
  ritornoBase, euroKm, oreAttesa = 0, costoAttesaOraEuro = 0,
  altriCostiEuro = 0, margineMinimoEuro = 0,
  contrattoTrasferimentiFisiciV2 = false
}) {
  if (!ciclo || ciclo.tipoPiano !== 'CICLO_PIXEL_CORSA_UNICA_V1' ||
      ciclo.attivabile !== false || ciclo.validazioneCapienza?.verificata !== true ||
      !Array.isArray(ciclo.evaluation?.requests) || !ciclo.evaluation.requests.length ||
      !Array.isArray(ciclo.missioni) || !Array.isArray(ciclo.legs) || !ciclo.legs.length ||
      !Array.isArray(missioni) || !missioni.length || missioni.length > 3 ||
      ciclo.missioni.length !== missioni.length ||
      !Array.isArray(missioniAdattate) || missioniAdattate.length !== missioni.length ||
      !Array.isArray(trasferimenti) || trasferimenti.length !== missioni.length - 1)
    fail('ciclo o composizione non validi');
  if (!numeroNonNegativo(euroKm)) fail('tariffa NCC non valida');

  const kmApproach = metri(avvicinamento, 'avvicinamento') / 1000;
  const kmReturn = metri(ritornoBase, 'ritorno base') / 1000;
  const nLegs = ciclo.legs.length;
  // Gli orari sono offset in millisecondi dalla partenza del ciclo.
  const times = ciclo.evaluation.times;
  const departure = ciclo.evaluation.departure;
  if (!Array.isArray(times) || times.length !== nLegs + 1 ||
      !Number.isFinite(departure) || times[0] !== 0)
    fail('cronologia del ciclo assente o non valida');
  for (let j = 0; j < nLegs; j++) {
    const durataMs = Number(ciclo.legs[j]?.seconds) * 1000;
    if (!Number.isFinite(times[j]) || !Number.isFinite(times[j + 1]) ||
        !Number.isFinite(durataMs) ||
        Math.abs(times[j + 1] - times[j] - durataMs) > 1)
      fail(`cronologia segmento ${j} incoerente`);
  }
  const metriAssemblati = sommaLegs(ciclo.legs, 'ciclo');
  let finePrecedente = 0;
  let metriMissioni = 0;
  let metriTrasferimenti = 0;
  const dettaglio = [];
  const idsMissioni = new Set();

  for (let i = 0; i < missioni.length; i++) {
    const meta = ciclo.missioni[i];
    const m = missioni[i];
    const start = meta?.startIndex, end = meta?.endIndex;
    if (!intero(start) || !intero(end) || end <= start || end > nLegs ||
        start < finePrecedente || (i === 0 && start !== 0) ||
        meta.ordine !== i + 1)
      fail(`missione ${i + 1}: intervallo assemblato non valido`);
    // Un confine spostato su una sosta a 0 km deve comunque essere rifiutato.
    const partenzaAssemblata = departure + times[start];
    const arrivoAssemblato = departure + times[end];
    if (!Number.isFinite(meta.partenza) || !Number.isFinite(meta.arrivo) ||
        Math.abs(partenzaAssemblata - meta.partenza) > 1000 ||
        Math.abs(arrivoAssemblato - meta.arrivo) > 1000 ||
        meta.arrivo <= meta.partenza)
      fail(`missione ${i + 1}: confini temporali incoerenti`);
    if (!m?.sequenza?.ok || !m?.temporale?.ok || !m?.qualita?.ok ||
        !m?.itinerario?.ok || m.itinerario.routingVerificato !== true)
      fail(`missione ${i + 1}: validazioni incomplete`);

    // Controllo obbligatorio di fedelta' all'output del Mission Adapter.
    // L'itinerario contiene soltanto i collegamenti stradali, mentre
    // missione.legs comprende anche soste e fermate coincidenti.
    const originale = missioniAdattate[i];
    if (!originale || !Array.isArray(originale.legs) ||
        originale.legs.length !== end - start ||
        !Array.isArray(originale.requests) || !originale.requests.length ||
        !Array.isArray(originale.nodes) || originale.nodes.length !== originale.legs.length + 1)
      fail(`missione ${i + 1}: struttura originale non allineata`);
    for (let j = 0; j < originale.legs.length; j++) {
      const a = originale.legs[j];
      const b = ciclo.legs[start + j];
      legValido(a, `missione originale ${i + 1}`, j);
      legValido(b, `missione assemblata ${i + 1}`, j);
      if (!quasiUguale(Number(a.metres), Number(b.metres)) ||
          Math.abs(Number(a.seconds) - Number(b.seconds)) > 0.001 ||
          a.polyline !== b.polyline ||
          (a.attesa === true) !== (b.attesa === true) ||
          (a.roadCoincident === true) !== (b.roadCoincident === true))
        fail(`missione ${i + 1}: segmento ${j} diverso dall'originale`);
    }
    if (!Array.isArray(ciclo.nodes) || ciclo.nodes.length !== nLegs + 1 ||
        originale.nodes.some((id, j) => Number(id) !== Number(ciclo.nodes[start + j])))
      fail(`missione ${i + 1}: nodi originali non allineati`);
    if (!Number.isFinite(originale.departure) || !Number.isFinite(originale.arrival) ||
        Math.abs(originale.departure - meta.partenza) > 1000 ||
        Math.abs(originale.arrival - meta.arrivo) > 1000)
      fail(`missione ${i + 1}: orari originali non allineati`);
    const originalRequests = new Map();
    for (const r of originale.requests) {
      if (!idValido(r?.id) || originalRequests.has(Number(r.id)) ||
          !intero(r.start) || !intero(r.end) || r.end <= r.start ||
          r.end >= originale.nodes.length)
        fail(`missione ${i + 1}: richiesta originale non valida`);
      originalRequests.set(Number(r.id), r);
    }
    const assembledRequests = ciclo.evaluation.requests.filter(r =>
      intero(r?.start) && intero(r?.end) && r.start >= start && r.end <= end);
    if (assembledRequests.length !== originalRequests.size)
      fail(`missione ${i + 1}: richieste originali non allineate`);
    for (const r of assembledRequests) {
      const o = originalRequests.get(Number(r.id));
      if (!o || r.start !== start + o.start || r.end !== start + o.end ||
          Number(r.posti_richiesti) !== Number(o.posti_richiesti))
        fail(`missione ${i + 1}: richiesta assemblata diversa dall'originale`);
    }

    const metriOriginali = sommaLegs(m.itinerario.legs, `missione ${i + 1}`, false);
    const metriCiclo = sommaLegs(ciclo.legs.slice(start, end), `ciclo missione ${i + 1}`);
    if (!quasiUguale(metriOriginali, metriCiclo))
      fail(`missione ${i + 1}: chilometri diversi dal ciclo assemblato`);

    const intervalloTrasferimento = ciclo.legs.slice(finePrecedente, start);
    if (i > 0) {
      const tr = trasferimenti[i - 1];
      const metriTrasferimento = metri(tr, `trasferimento ${i}`);
      const originaleTratta = tr?.leg ?? tr;
      const coincidente = intervalloTrasferimento.length === 0 &&
        Number(tr?.metres) === 0 && Number(tr?.seconds) === 0 &&
        tr?.routingVerificato === true && tr?.roadCoincident === true &&
        Number(originaleTratta?.metres) === 0 &&
        Number(originaleTratta?.seconds) === 0 &&
        originaleTratta?.roadCoincident === true &&
        typeof originaleTratta?.polyline === 'string' &&
        originaleTratta.polyline.length > 0 &&
        Number(ciclo.nodes[finePrecedente]) === Number(ciclo.nodes[start]) &&
        Number(missioniAdattate[i - 1]?.nodes?.at(-1)) ===
          Number(missioniAdattate[i]?.nodes?.[0]) &&
        Math.abs(Number(ciclo.missioni[i - 1]?.arrivo) -
          Number(meta.partenza)) <= 1000;

      const metriCicloTrasferimento = coincidente
        ? 0
        : sommaLegs(intervalloTrasferimento, `ciclo trasferimento ${i}`);
      if (!quasiUguale(metriTrasferimento, metriCicloTrasferimento))
        fail(`trasferimento ${i}: chilometri diversi dal ciclo assemblato`);

      // Contratto V2: il segmento stradale originale deve coincidere con quello
      // assemblato. I segmenti di attesa sono separati e non sono routing.
      // Compatibilita' legacy: i vecchi diagnostici forniscono soltanto i metri.
      // Se invece e' presente un routing originale completo, lo confrontiamo
      // sempre, anche senza flag, per impedire manomissioni silenziose.
      const originaleCompleto = numeroNonNegativo(originaleTratta?.seconds) &&
        typeof originaleTratta?.polyline === 'string' && originaleTratta.polyline.length > 0;
      if (contrattoTrasferimentiFisiciV2 && !originaleCompleto && metriTrasferimento > 0)
        fail(`trasferimento ${i}: routing originale V2 incompleto`);
      if (originaleCompleto) {
        legValido(originaleTratta, `trasferimento originale ${i}`, 0);
        if (!quasiUguale(Number(originaleTratta.metres), metriTrasferimento))
          fail(`trasferimento ${i}: metri originali incoerenti`);
        const segmentiStradali = intervalloTrasferimento.filter(l => l?.attesa !== true);

        if (coincidente) {
          const fermata = ciclo.coordinates?.[start];
          if (!fermata || !Number.isFinite(Number(fermata.lat)) ||
              !Number.isFinite(Number(fermata.lon)))
            fail(`trasferimento ${i}: coordinate fermata assenti`);

          let decoded;
          try {
            decoded = polyline.decode(originaleTratta.polyline);
          } catch {
            fail(`trasferimento ${i}: polilinea coincidente malformata`);
          }

          if (!Array.isArray(decoded) || decoded.length < 2 ||
              decoded.some(p => !Array.isArray(p) || p.length < 2 ||
                !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
            fail(`trasferimento ${i}: geometria coincidente invalida`);

          const rad = Math.PI / 180;
          const distanza = p => 6371008.8 * Math.hypot(
            (p[0] - Number(fermata.lat)) * rad,
            Math.cos(Number(fermata.lat) * rad) *
              (p[1] - Number(fermata.lon)) * rad
          );

          if (decoded.some(p => distanza(p) > 0.5))
            fail(`trasferimento ${i}: geometria non coincidente`);
        } else {
          if (segmentiStradali.length !== 1)
            fail(`trasferimento ${i}: numero segmenti stradali incoerente`);

          const assemblato = segmentiStradali[0];
          legValido(assemblato, `trasferimento assemblato ${i}`, 0);

          if (!quasiUguale(Number(originaleTratta.metres), Number(assemblato.metres)) ||
              Math.abs(Number(originaleTratta.seconds) - Number(assemblato.seconds)) > 0.001 ||
              originaleTratta.polyline !== assemblato.polyline ||
              (originaleTratta.roadCoincident === true) !== (assemblato.roadCoincident === true))
            fail(`trasferimento ${i}: segmento diverso dall'originale`);
        }
      }
      // La distanza del trasferimento non include eventuali segmenti di attesa a zero km.
      metriTrasferimenti += metriCicloTrasferimento;
    } else if (intervalloTrasferimento.length) {
      fail('segmenti precedenti alla prima missione');
    }

    if (!Array.isArray(meta.richieste) || !meta.richieste.length)
      fail(`missione ${i + 1}: richieste mancanti`);
    const idsMeta = new Set();
    for (const id of meta.richieste) {
      if (!idValido(id) || idsMeta.has(Number(id)) || idsMissioni.has(Number(id)))
        fail(`missione ${i + 1}: richieste duplicate o non valide`);
      idsMeta.add(Number(id));
      idsMissioni.add(Number(id));
    }
    const richiesteIntervallo = ciclo.evaluation.requests.filter(r =>
      intero(r?.start) && intero(r?.end) && r.start >= start && r.end <= end && r.end > r.start);
    if (richiesteIntervallo.length !== idsMeta.size ||
        richiesteIntervallo.some(r => !idsMeta.has(Number(r.id))))
      fail(`missione ${i + 1}: richieste non corrispondenti agli indici`);

    metriMissioni += metriCiclo;
    dettaglio.push({ ordine: i + 1, startIndex: start, endIndex: end, kmMissione: metriCiclo / 1000 });
    finePrecedente = end;
  }
  if (finePrecedente !== nLegs) fail('segmenti finali non attribuiti a missioni o trasferimenti');
  if (!quasiUguale(metriAssemblati, metriMissioni + metriTrasferimenti))
    fail('chilometri complessivi non coerenti');

  if (!Array.isArray(richieste) || !richieste.length) fail('catalogo richieste assente');
  const prezzi = new Map();
  for (const r of richieste) {
    if (!idValido(r?.id) || prezzi.has(Number(r.id)) || !numeroNonNegativo(r.prezzo))
      fail('richiesta originale duplicata o prezzo non valido');
    prezzi.set(Number(r.id), Number(r.prezzo));
  }
  const ids = new Set();
  const ricaviRichiesteEuro = [];
  for (const r of ciclo.evaluation.requests) {
    if (!idValido(r?.id) || ids.has(Number(r.id)) || !prezzi.has(Number(r.id)) ||
        !idsMissioni.has(Number(r.id)) || !intero(r.start) || !intero(r.end) ||
        r.end <= r.start || r.end > nLegs)
      fail('richiesta del ciclo duplicata, fuori intervallo o senza prezzo');
    ids.add(Number(r.id));
    ricaviRichiesteEuro.push(prezzi.get(Number(r.id)));
  }
  if (ids.size !== prezzi.size || ids.size !== idsMissioni.size)
    fail('catalogo richieste non corrispondente al ciclo');

  const economia = valutaEconomiaCiclo({
    ricaviRichiesteEuro,
    kmAvvicinamento: kmApproach,
    kmMissioni: metriMissioni / 1000,
    kmTrasferimenti: metriTrasferimenti / 1000,
    kmRitornoBase: kmReturn,
    euroKm: Number(euroKm), oreAttesa, costoAttesaOraEuro,
    altriCostiEuro, margineMinimoEuro
  });
  return {
    ok: true,
    stato: economia.economicamenteAttivabile ? 'SOGLIA_ECONOMICA_RAGGIUNTA' : 'SOGLIA_ECONOMICA_NON_RAGGIUNTA',
    richiesteValutate: [...ids], dettaglioMissioni: dettaglio, economia,
    economicamenteAttivabile: economia.economicamenteAttivabile,
    attivabile: false
  };
}
