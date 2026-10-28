import polyline from '@mapbox/polyline';

// TURENTU POPBUS — composizione pura: fino a tre missioni, una sola corsa.
// Nessuna scrittura DB, nessuna attivazione automatica.
// Contratto: requests delle missioni contengono {id,start,end,posti_richiesti}.
// Se posti_richiesti o postiTotali mancano, il piano resta diagnostico e la
// capienza NON e' dichiarata validata. La fonte autorevole dei posti e' il DB:
// rivalidare sempre prima dell'accettazione.

const num = (x, name) => {
  if (x == null || x === '' || typeof x === 'boolean') throw Error(`${name} non valido`);
  const n = Number(x);
  if (!Number.isFinite(n)) throw Error(`${name} non valido`);
  return n;
};
const validId = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;
const close = (a, b) => Math.abs(a - b) <= 1000;
const point = n => {
  if (!n || !validId(n.id)) throw Error('Nodo non valido');
  const lat = num(n.lat, 'lat'), lon = num(n.lon, 'lon');
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Error('Coordinate nodo non valide');
  return { id: Number(n.id), lat, lon, nome_nodo: n.nome_nodo ?? null };
};
function encodePair(p) {
  const enc = n => {
    let v = n < 0 ? ~(n << 1) : (n << 1), s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  return enc(Math.round(p.lat * 1e5)) + enc(Math.round(p.lon * 1e5)) + '??';
}

// Contratto opzionale, esclusivo dei trasferimenti fisici V2.
// Non certifica la provenienza dal provider stradale: il writer deve rivalidarla.
const metriFraCoordinate = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (Number(b.lat) - Number(a.lat)) * rad;
  const dLon = (Number(b.lon) - Number(a.lon)) * rad;
  const latMedia = ((Number(a.lat) + Number(b.lat)) / 2) * rad;
  return 6371008.8 * Math.hypot(dLat, Math.cos(latMedia) * dLon);
};

function verificaTrasferimentoFisicoV2(tr, last, next) {
  const secs = num(tr.seconds, 'trasferimento.seconds');
  const metres = num(tr.metres, 'trasferimento.metres');
  if (secs < 0 || metres < 0) throw Error('Trasferimento V2: durata o distanza negativa');
  const stessoPunto = metriFraCoordinate(last, next) < 0.5;
  if (stessoPunto && last.id !== next.id)
    throw Error('Trasferimento V2: fermate coincidenti con ID diversi da verificare nel catalogo');
  if (stessoPunto && secs === 0 && metres === 0) {
    if (tr.leg != null) {
      if (num(tr.leg.seconds, 'trasferimento.leg.seconds') !== 0 ||
          num(tr.leg.metres, 'trasferimento.leg.metres') !== 0)
        throw Error('Trasferimento V2: segmento coincidente incoerente');
    }
    return;
  }
  if (stessoPunto || secs <= 0 || metres <= 0)
    throw Error('Trasferimento V2: spostamento stradale non valido');

  const leg = tr.leg ?? tr;
  if (Math.abs(num(leg.seconds, 'trasferimento.leg.seconds') - secs) > 0.001 ||
      Math.abs(num(leg.metres, 'trasferimento.leg.metres') - metres) > 0.01)
    throw Error('Trasferimento V2: metri o secondi non coerenti con il segmento');
  if (typeof leg.polyline !== 'string' || !leg.polyline.length)
    throw Error('Trasferimento V2: polilinea mancante');
  let pts;
  try { pts = polyline.decode(leg.polyline); }
  catch { throw Error('Trasferimento V2: polilinea malformata'); }
  if (!Array.isArray(pts) || pts.length < 2 || pts.some(p =>
      !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180))
    throw Error('Trasferimento V2: polilinea malformata');
  const first = { lat: pts[0][0], lon: pts[0][1] };
  const final = { lat: pts.at(-1)[0], lon: pts.at(-1)[1] };
  // Tolleranza per arrotondamento e accesso stradale, non prova di routing reale.
  if (metriFraCoordinate(first, last) > 50 || metriFraCoordinate(final, next) > 50)
    throw Error('Trasferimento V2: polilinea non ancorata alle fermate');
}

// Occorrenze: l'occupazione si misura su [start,end), non sommando i passeggeri
// trasportati nell'intero ciclo. Le discese al nodo precedono le salite.
export function calcolaOccupazioneCiclo(requests, numeroSegmenti, postiTotali = null) {
  if (!Number.isSafeInteger(numeroSegmenti) || numeroSegmenti < 1) throw Error('Segmenti non validi');
  const delta = Array(numeroSegmenti + 1).fill(0);
  let totalePasseggeri = 0;
  const ids = new Set();
  for (const r of requests) {
    if (!validId(r.id) || ids.has(Number(r.id))) throw Error('Richiesta duplicata o non valida');
    ids.add(Number(r.id));
    const s = Number(r.start), e = Number(r.end), p = num(r.posti_richiesti, 'posti_richiesti');
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < 0 || e <= s || e > numeroSegmenti ||
        !Number.isSafeInteger(p) || p <= 0) throw Error('Occorrenza o posti non validi');
    delta[s] += p;
    delta[e] -= p;
    totalePasseggeri += p;
  }
  let capienza = null;
  if (postiTotali != null) {
    capienza = num(postiTotali, 'postiTotali');
    if (!Number.isSafeInteger(capienza) || capienza <= 0) throw Error('Capienza veicolo non valida');
  }
  let occupati = 0, peak = 0;
  const occupazioneSegmenti = [];
  for (let i = 0; i < numeroSegmenti; i++) {
    occupati += delta[i];
    if (occupati < 0) throw Error('Occupazione negativa');
    if (capienza != null && occupati > capienza) throw Error(`Capienza superata al segmento ${i}: ${occupati}/${capienza}`);
    peak = Math.max(peak, occupati);
    occupazioneSegmenti.push(occupati);
  }
  if (occupati + delta[numeroSegmenti] !== 0) throw Error('Occupazione finale incoerente');
  return { peak, totalePasseggeri, occupazioneSegmenti, postiTotali: capienza };
}

export function componiCicloInCorsa({
  missioni, trasferimenti = [], nodi, veicoloId, busyStart, busyEnd,
  approach, returnTrip, postiTotali = null, contrattoTrasferimentiFisiciV2 = false
}) {
  if (!Array.isArray(missioni) || missioni.length < 1 || missioni.length > 3 ||
      !Array.isArray(trasferimenti) || trasferimenti.length !== missioni.length - 1)
    throw Error('Missioni/trasferimenti incoerenti');
  if (!validId(veicoloId)) throw Error('Veicolo non valido');
  if (!Array.isArray(nodi) || !nodi.length) throw Error('Nodi assenti');
  const nodeMap = new Map();
  for (const n of nodi) {
    const p = point(n);
    if (nodeMap.has(p.id)) throw Error(`Nodo duplicato nel catalogo: ${p.id}`);
    nodeMap.set(p.id, p);
  }
  const nodes = [], legs = [], requests = [], missionMeta = [];
  let departure = null, elapsed = 0, prevArrival = null;
  const appendLeg = (leg, label) => {
    if (!leg || num(leg.metres, `${label}.metres`) < 0 ||
        num(leg.seconds, `${label}.seconds`) < 0 ||
        typeof leg.polyline !== 'string' || !leg.polyline.length)
      throw Error(`${label}: geometria verificata mancante`);
    legs.push({ ...leg, metres: Number(leg.metres), seconds: Number(leg.seconds) });
    elapsed += Number(leg.seconds) * 1000;
  };
  const ids = new Set();
  for (let i = 0; i < missioni.length; i++) {
    const m = missioni[i];
    if (!m || !Array.isArray(m.nodes) || m.nodes.length < 2 ||
        !Array.isArray(m.legs) || m.legs.length !== m.nodes.length - 1 ||
        !Array.isArray(m.requests) || !m.requests.length)
      throw Error(`Missione ${i + 1} invalida`);
    const start = num(m.departure, 'partenza'), end = num(m.arrival, 'arrivo');
    if (start >= end) throw Error('Orari missione invalidi');
    if (i === 0) departure = start;
    else {
      const tr = trasferimenti[i - 1];
      const last = nodes.at(-1), next = nodeMap.get(Number(m.nodes[0]));
      if (!tr || !next || !last) throw Error('Nodo trasferimento mancante');
      const secs = num(tr.seconds, 'trasferimento.seconds');
      const wait = num(tr.attesaMinuti ?? 0, 'attesaMinuti') * 60;
      if (secs < 0 || wait < 0 || !close(prevArrival + (secs + wait) * 1000, start))
        throw Error('Trasferimento/attesa non coerenti con orari');
      if (contrattoTrasferimentiFisiciV2) verificaTrasferimentoFisicoV2(tr, last, next);
      if (secs > 0 || last.id !== next.id) {
        appendLeg(tr.leg ?? tr, 'trasferimento');
        nodes.push(next);
      } else if (wait > 0) {
        // Mantiene separati gli indici delle due missioni sullo stesso nodo.
        appendLeg({ metres: 0, seconds: 0, polyline: encodePair(last), roadCoincident: true }, 'nodo coincidente');
        nodes.push({ ...last });
      }
      if (wait > 0) {
        const p = nodes.at(-1);
        appendLeg({ metres: 0, seconds: wait, polyline: encodePair(p), attesa: true }, 'attesa');
        nodes.push({ ...p });
      }
    }
    if (!nodes.length) {
      const first = nodeMap.get(Number(m.nodes[0]));
      if (!first) throw Error('Nodo iniziale mancante');
      nodes.push(first);
    }
    if (nodes.at(-1).id !== Number(m.nodes[0])) throw Error('Nodo iniziale missione non allineato');
    const missionStartIndex = nodes.length - 1;
    for (let j = 0; j < m.legs.length; j++) {
      const next = nodeMap.get(Number(m.nodes[j + 1]));
      if (!next) throw Error('Nodo missione mancante');
      appendLeg(m.legs[j], `missione ${i + 1} leg ${j + 1}`);
      nodes.push(next);
    }
    if (!close(departure + elapsed, end)) throw Error(`Missione ${i + 1}: durata del routing diversa dal piano`);
    for (const r of m.requests) {
      const id = Number(r.id), s = Number(r.start), e = Number(r.end);
      if (!validId(r.id) || ids.has(id) || !Number.isSafeInteger(s) ||
          !Number.isSafeInteger(e) || s < 0 || e <= s || e >= m.nodes.length)
        throw Error('Richiesta o indici non validi');
      ids.add(id);
      const entry = { id, start: missionStartIndex + s, end: missionStartIndex + e };
      if (r.posti_richiesti != null) {
        const p = num(r.posti_richiesti, 'posti_richiesti');
        if (!Number.isSafeInteger(p) || p <= 0) throw Error('Posti richiesti non validi');
        entry.posti_richiesti = p;
      }
      requests.push(entry);
    }
    missionMeta.push({ ordine: i + 1, corridoioPixelId: m.corridorId ?? null,
      partenza: start, arrivo: end, startIndex: missionStartIndex,
      endIndex: nodes.length - 1, richieste: m.requests.map(r => Number(r.id)) });
    prevArrival = end;
  }
  const times = [0];
  for (const l of legs) times.push(times.at(-1) + l.seconds * 1000);
  if (nodes.length !== legs.length + 1 || times.length !== nodes.length)
    throw Error('Geometria globale incoerente');
  const bs = new Date(busyStart).getTime(), be = new Date(busyEnd).getTime();
  if (!Number.isFinite(bs) || !Number.isFinite(be) || bs >= be || bs > departure || be < prevArrival)
    throw Error('Intervallo occupazione incompleto');
  const capienzaValidata = postiTotali != null && requests.every(r => r.posti_richiesti != null);
  const occupazione = requests.every(r => r.posti_richiesti != null)
    ? calcolaOccupazioneCiclo(requests, legs.length, postiTotali)
    : null;
  // Non attribuire peak a un piano incompleto: acceptance usa questo campo
  // per il controllo di capienza. Non e' un'autorizzazione ad attivare.
  return {
    tipoPiano: 'CICLO_PIXEL_CORSA_UNICA_V1', veicoloId: Number(veicoloId),
    nodes: nodes.map(n => n.id), coordinates: nodes, legs,
    evaluation: { departure, arrival: prevArrival, times, requests,
      ...(occupazione ? { peak: occupazione.peak } : {}) },
    missioni: missionMeta, approach, returnTrip,
    busyStart: new Date(bs).toISOString(), busyEnd: new Date(be).toISOString(),
    validazioneCapienza: { verificata: capienzaValidata,
      peak: occupazione?.peak ?? null,
      totalePasseggeri: occupazione?.totalePasseggeri ?? null,
      occupazioneSegmenti: occupazione?.occupazioneSegmenti ?? null,
      postiTotali: occupazione?.postiTotali ?? null },
    // Mancano ancora rivalidazione DB, qualita', pagamenti, fingerprint,
    // verifica polilinee contro i nodi e transazione di accettazione.
    attivabile: false
  };
}
