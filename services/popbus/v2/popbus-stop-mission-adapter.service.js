// TURENTU POPBUS V2 - Adattatore isolato delle missioni con fermate fisiche.
// Nessuna query DB, nessuna attivazione, nessuna modifica ai servizi LIVE.
// Converte una missione validata nel contratto di componiCicloInCorsa().

const fail = message => { throw new Error(`POPBUS_STOP_MISSION_ADAPTER: ${message}`); };
const validId = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const near = (a, b) => Math.abs(a - b) <= 1; // tolleranza numerica in ms

// Encoded polyline per un punto ripetuto: geometria rappresentativa della sosta.
// Non e' una certificazione di percorribilita' stradale.
function encodePoint(lat, lon) {
  const encode = value => {
    let v = Math.round(value * 1e5);
    v = v < 0 ? ~(v << 1) : (v << 1);
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  return encode(lat) + encode(lon) + '??';
}

export function adattaMissioneFermate({ alternativa, richieste, corridorId = null }) {
  if (!alternativa?.sequenza?.ok || !alternativa?.temporale?.ok ||
      !alternativa?.qualita?.ok || !alternativa?.itinerario?.ok ||
      alternativa.itinerario.routingVerificato !== true) fail('validazioni missione incomplete');
  const it = alternativa.itinerario;
  if (!Array.isArray(it.visite) || it.visite.length < 2 ||
      !Array.isArray(it.legs) || it.legs.length !== it.visite.length - 1 ||
      !finite(it.departure) || !finite(it.fineOperazioni)) fail('itinerario incompleto');
  if (!Array.isArray(richieste) || !richieste.length) fail('richieste mancanti');
  const byId = new Map();
  for (const r of richieste) {
    if (!validId(r?.id) || byId.has(Number(r.id)) ||
        !Number.isSafeInteger(Number(r.posti_richiesti)) || Number(r.posti_richiesti) <= 0)
      fail('richiesta non valida o duplicata');
    byId.set(Number(r.id), r);
  }

  const nodi = [];
  const nodes = [];
  const legs = [];
  const events = new Map();
  const seenStops = new Map();
  let current = it.departure;

  const addNode = visita => {
    if (!validId(visita.fermata_id) || !finite(Number(visita.lat)) ||
        !finite(Number(visita.lon)) || Math.abs(Number(visita.lat)) > 90 ||
        Math.abs(Number(visita.lon)) > 180) fail('fermata non valida');
    const id = Number(visita.fermata_id);
    const lat = Number(visita.lat), lon = Number(visita.lon);
    const old = seenStops.get(id);
    if (old && (Math.abs(old.lat - lat) > 1e-7 || Math.abs(old.lon - lon) > 1e-7))
      fail('coordinate incoerenti per la stessa fermata');
    if (!old) {
      const node = { id, lat, lon, nome_nodo: visita.nome ?? null };
      seenStops.set(id, node);
      nodi.push(node);
    }
    nodes.push(id);
  };

  for (let i = 0; i < it.visite.length; i++) {
    const v = it.visite[i];
    if (!finite(v.arrivo) || !finite(v.partenza) || !finite(v.sostaSecondi) ||
        v.sostaSecondi < 0 || !Array.isArray(v.eventi) || !v.eventi.length)
      fail(`visita ${i}: tempi o eventi non validi`);
    if (!near(v.arrivo, current) || !near(v.partenza, v.arrivo + v.sostaSecondi * 1000))
      fail(`visita ${i}: cronologia incoerente`);
    addNode(v);
    const arrivalIndex = nodes.length - 1;

    for (const ev of v.eventi) {
      const id = Number(ev.richiesta_id);
      if (!byId.has(id) || !['salita', 'discesa'].includes(ev.tipo) ||
          Number(ev.posti) !== Number(byId.get(id).posti_richiesti))
        fail(`visita ${i}: evento non valido`);
      if (ev.timestampOperazione != null && !near(Number(ev.timestampOperazione), v.arrivo))
        fail(`visita ${i}: timestamp evento incoerente`);
      const entry = events.get(id) ?? {};
      if (entry[ev.tipo] != null) fail(`evento duplicato per richiesta ${id}`);
      entry[ev.tipo] = arrivalIndex;
      events.set(id, entry);
    }

    // La sosta viene rappresentata da un'occorrenza aggiuntiva dello stesso nodo.
    // Gli eventi restano all'indice di ARRIVO: la salita e' operativa prima del
    // successivo segmento, la discesa libera posti prima delle nuove salite.
    if (v.sostaSecondi > 0) {
      legs.push({ metres: 0, seconds: v.sostaSecondi,
        polyline: encodePoint(Number(v.lat), Number(v.lon)), attesa: true });
      nodes.push(Number(v.fermata_id));
    }
    current = v.partenza;

    if (i < it.visite.length - 1) {
      const road = it.legs[i];
      if (!finite(Number(road?.metres)) || !finite(Number(road?.seconds)) ||
          Number(road.metres) < 0 || Number(road.seconds) < 0) fail(`leg ${i} non valido`);
      const coincident = Number(road.metres) === 0 && Number(road.seconds) === 0 &&
        road.coincidente === true;
      if (!coincident && (Number(road.metres) <= 0 || Number(road.seconds) <= 0 ||
          typeof road.polyline !== 'string' || !road.polyline.length))
        fail(`leg ${i}: geometria stradale non verificata`);
      const polyline = coincident
        ? encodePoint(Number(v.lat), Number(v.lon))
        : road.polyline;
      legs.push({ metres: Number(road.metres), seconds: Number(road.seconds),
        polyline, ...(coincident ? { roadCoincident: true } : {}) });
      current += Number(road.seconds) * 1000;
    }
  }

  if (!near(current, it.fineOperazioni) || nodes.length !== legs.length + 1)
    fail('durata o geometria finale incoerente');
  const missionRequests = [];
  for (const [id, r] of byId) {
    const e = events.get(id);
    if (!e || !Number.isSafeInteger(e.salita) || !Number.isSafeInteger(e.discesa) ||
        e.salita >= e.discesa) fail(`richiesta ${id}: occorrenze incomplete`);
    missionRequests.push({ id, start: e.salita, end: e.discesa,
      posti_richiesti: Number(r.posti_richiesti) });
  }
  if (events.size !== byId.size) fail('richieste non allineate');
  return {
    ok: true,
    stato: 'MISSIONE_FERMATE_ADATTATA',
    missione: { nodes, legs, requests: missionRequests,
      departure: it.departure, arrival: it.fineOperazioni,
      corridorId },
    nodi,
    diagnostica: { visiteFisiche: it.visite.length,
      occorrenzeOperative: nodes.length,
      segmenti: legs.length,
      soste: legs.filter(l => l.attesa === true).length,
      richieste: missionRequests.length },
    attivabile: false
  };
}
