// PATCH CONSERVATIVA: sincronizzazione appartenenza territoriale nelle varianti.
// Non implementa generazione esaustiva di varianti o composizione di direttrici.
// TURENTU PIXEL — motore incrementale V1 (in memoria)
// Nessun DB, HTTP o assegnazione missioni. I nodi sono ID di nodi_territoriali.
// Le estensioni sono ammesse SOLO se validate da routeNodes iniettato.
import { normalizzaRichiesta, intersezionePartenze } from './model.js';
import { finestreRitornoPerNodo } from './pixel-node-return-windows.js';
import { gruppiTemporaliCompleti } from './pixel-temporal-complete.js';

function assert(ok, message) { if (!ok) throw new TypeError(`PIXEL_INCREMENTAL: ${message}`); }
function freezeArray(a) { return Object.freeze([...a]); }
function normalizeTerritorialRequest(input) {
  assert(input && typeof input === 'object', 'richiesta mancante');
  const a = input.origine_nodo_territoriale_id;
  const b = input.destinazione_nodo_territoriale_id;
  assert(a != null && b != null, 'ID territoriali obbligatori');
  // Adattamento esplicito: non interpretiamo start_node_id come ID territoriale.
  const r = normalizzaRichiesta({ ...input, start_node_id: a, end_node_id: b });
  return Object.freeze({ ...r, origine_nodo_territoriale_id: r.start_node_id,
    destinazione_nodo_territoriale_id: r.end_node_id });
}
function normalizeLegs(legs, count) {
  assert(Array.isArray(legs) && legs.length === count - 1, 'numero tratte non coerente');
  return freezeArray(legs.map((l, i) => {
    assert(l && Number.isFinite(l.metres) && Number.isFinite(l.seconds) && l.metres >= 0 && l.seconds >= 0,
      `tratta ${i} non valida`);
    assert((l.metres > 0 && l.seconds > 0) || (l.metres === 0 && l.seconds === 0 && l.roadCoincident === true),
      `tratta ${i} priva di routing valido`);
    assert(typeof l.polyline === 'string' && l.polyline.length > 0, `tratta ${i} senza geometria`);
    return Object.freeze({ metres: l.metres, seconds: l.seconds, polyline: l.polyline,
      roadCoincident: l.roadCoincident === true });
  }));
}
function normalizeCorridor({ id, nodes, legs, richiestaIds = [], versione = 1 }) {
  assert(typeof id === 'string' && id.length > 0, 'ID direttrice non valido');
  assert(Array.isArray(nodes) && nodes.length >= 2 && nodes.every(n => Number.isSafeInteger(n) && n > 0), 'nodi non validi');
  assert(new Set(nodes).size === nodes.length, 'nodi duplicati');
  assert(Array.isArray(richiestaIds) && new Set(richiestaIds).size === richiestaIds.length, 'richieste duplicate');
  return Object.freeze({ id, nodes: freezeArray(nodes), legs: normalizeLegs(legs, nodes.length),
    richiestaIds: freezeArray(richiestaIds), versione, verificataRouting: true });
}
function containsOrdered(nodes, r) {
  const a = nodes.indexOf(r.start_node_id), b = nodes.indexOf(r.end_node_id);
  return a !== -1 && b !== -1 && a < b;
}
function extensionCandidates(nodes, r) {
  const a = nodes.indexOf(r.start_node_id), b = nodes.indexOf(r.end_node_id);
  const out = [];
  // Retroestensione: nuova origine -> nodo di destinazione gia' nella direttrice.
  if (a === -1 && b !== -1) out.push({ tipo: 'retroestensione', nodes: [r.start_node_id, ...nodes] });
  // Estensione: origine gia' nella direttrice -> nuova destinazione.
  if (a !== -1 && b === -1) out.push({ tipo: 'estensione', nodes: [...nodes, r.end_node_id] });
  // Nessun inserimento interno o variante con entrambi i nodi assenti in V1.
  return out;
}
function offsetSeconds(c, nodeId) {
  const idx = c.nodes.indexOf(nodeId);
  assert(idx >= 0, 'nodo non presente');
  return c.legs.slice(0, idx).reduce((s, l) => s + l.seconds, 0);
}

export function createIncrementalCorridorEngine({ routeNodes, initialCorridors = [], tolleranzaMinuti = 30 } = {}) {
  assert(typeof routeNodes === 'function', 'routeNodes obbligatoria');
  assert(Number.isFinite(tolleranzaMinuti) && tolleranzaMinuti >= 0, 'tolleranza non valida');
  const corridors = new Map();
  const requests = new Map();
  let nextId = 1;
  // Cache esclusivamente geometrica: il risultato temporale viene ricalcolato
  // sulle richieste correnti, senza riservarle o duplicarle.
  const reverseRouteCache = new Map();
  // Cache temporale per direttrice e buffer: invalida solo dipendenze pertinenti.
  const temporalReturnCache = new Map();
  const revisions = new Map();
  const pendingChanges = new Set();
  const revisionOf = id => revisions.get(id) ?? 0;
  function invalidate(ids) {
    for (const id of ids) {
      revisions.set(id, revisionOf(id) + 1);
      pendingChanges.add(id);
      temporalReturnCache.delete(id);
    }
  }
  function affectedByRequest(r) {
    const a = r.start_node_id, b = r.end_node_id;
    return [...corridors.values()].filter(c => {
      const i = c.nodes.indexOf(a), j = c.nodes.indexOf(b);
      // Domanda lungo la direttrice oppure domanda inversa su una sottotratta.
      return i !== -1 && j !== -1 && i !== j;
    }).map(c => c.id);
  }
  const routeKey = nodes => nodes.join('>');
  for (const c of initialCorridors) {
    const n = normalizeCorridor(c);
    assert(!corridors.has(n.id), 'ID direttrice duplicato');
    assert(n.richiestaIds.length === 0, 'inizializzazione con richieste richiede storico esplicito');
    corridors.set(n.id, n);
    const match = /^px-(\d+)$/.exec(n.id);
    if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
  }
  const listCorridors = () => freezeArray([...corridors.values()]);
  const getCorridor = id => corridors.get(id) ?? null;
  const getRequest = id => requests.get(id) ?? null;
  // Appartenenza territoriale: ogni richiesta nota i cui estremi compaiono
  // nell'ordine corretto deve appartenere alla variante, non solo la richiesta
  // che ha provocato l'estensione. Non implica compatibilita temporale.
  function territorialMembership(nodes) {
    return [...requests.values()]
      .filter(req => containsOrdered(nodes, req))
      .map(req => req.id);
  }
  function synchronizeMembership(c) {
    const ids = territorialMembership(c.nodes);
    if (ids.length === c.richiestaIds.length && ids.every(id => c.richiestaIds.includes(id))) return c;
    return normalizeCorridor({ ...c, richiestaIds: ids });
  }
  function membershipWindow(c, ids) {
    if (ids.length === 0) return null;
    return intersezionePartenze(ids.map(id => ({ richiesta: requests.get(id),
      offsetSecondi: offsetSeconds(c, requests.get(id).start_node_id), tolleranzaMinuti })));
  }
  function temporalCandidates(id) {
    const c = corridors.get(id);
    assert(c, 'direttrice sconosciuta');
    // Sottogruppi compatibili rispetto alla prima partenza teorica; NON una formazione POPBUS.
    const groups = [];
    const sorted = [...c.richiestaIds].sort((a,b) => requests.get(a).start_datetime_ms - offsetSeconds(c, requests.get(a).start_node_id)*1000 - (requests.get(b).start_datetime_ms - offsetSeconds(c, requests.get(b).start_node_id)*1000) || a-b);
    for (const idReq of sorted) {
      const candidates = groups.filter(g => membershipWindow(c, [...g, idReq]) !== null);
      if (candidates.length) candidates[0].push(idReq);
      else groups.push([idReq]);
    }
    return freezeArray(groups.map(ids => Object.freeze({ richiestaIds: freezeArray(ids),
      finestraPartenza: membershipWindow(c, ids), preliminare: true })));
  }
  // Diagnostica esaustiva dei gruppi massimali: non sostituisce la V1.
  // Una richiesta puo' comparire in piu' gruppi alternativi.
  function temporalCandidatesComplete(id) {
    const c = corridors.get(id);
    assert(c, 'direttrice sconosciuta');
    return gruppiTemporaliCompleti({
      richieste: c.richiestaIds.map(reqId => requests.get(reqId)),
      offsetSecondi: r => offsetSeconds(c, r.start_node_id),
      tolleranzaMinuti
    });
  }
  async function verifiedRoute(nodes) {
    const result = await routeNodes(freezeArray(nodes));
    assert(result && result.verificataRouting === true, 'routing non verificato');
    return normalizeLegs(result.legs, nodes.length);
  }
  // Converte l'intervallo restituito da model.intersezionePartenze
  // senza inventare date o accettare limiti non riconosciuti.
  function normalizedWindow(w) {
    if (!w) return null;
    const a = w.inizioMs ?? w.inizio_ms ?? w.minMs ?? w.daMs ?? w.inizio ?? w.min ?? w.start;
    const b = w.fineMs ?? w.fine_ms ?? w.maxMs ?? w.aMs ?? w.fine ?? w.max ?? w.end;
    const toMs = v => v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : v;
    const startMs = toMs(a), endMs = toMs(b);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      throw new TypeError('PIXEL_INCREMENTAL: formato finestraPartenza non riconosciuto; adattare normalizedWindow al model.js');
    }
    return { inizioMs: startMs, fineMs: endMs };
  }
  async function reverseRoute(nodes) {
    const key = routeKey(nodes);
    if (reverseRouteCache.has(key)) return reverseRouteCache.get(key);
    // Un routing inverso NON si ricava invertendo le tratte dell'andata.
    // La cache memorizza soltanto percorsi verificati.
    const legs = await verifiedRoute(nodes);
    const route = Object.freeze({ nodes: freezeArray(nodes), legs });
    reverseRouteCache.set(key, route);
    return route;
  }
  // API additiva: temporalCandidates() resta sincrona e invariata.
  // Il risultato contiene per ogni nodo le finestre di ritorno per ogni
  // punto di inversione raggiungibile sulla direttrice orientata.
  async function buildCandidatesWithReturns(id, { bufferMinuti = 0 } = {}, complete = false, attempt = 0) {
    assert(Number.isFinite(bufferMinuti) && bufferMinuti >= 0, 'buffer non valido');
    const c = corridors.get(id);
    assert(c, 'direttrice sconosciuta');
    const key = `${complete ? "complete" : "v1"}:${bufferMinuti}`;
    const rev = revisionOf(id);
    const cached = temporalReturnCache.get(id)?.get(key);
    if (cached && cached.revision === rev) return cached.value;
    const base = complete ? temporalCandidatesComplete(id) : temporalCandidates(id);
    const returns = new Map();
    for (let j = 1; j < c.nodes.length; j++) {
      const inverseNodes = c.nodes.slice(0, j + 1).reverse();
      try {
        returns.set(c.nodes[j], await reverseRoute(inverseNodes));
      } catch {
        // Routing non certificato: nessuna finestra per quell'inversione.
      }
    }
    // Include anche richieste che appartengono a direttrici inverse o
    // diverse, purché i loro estremi siano sul percorso inverso verificato.
    const availableRequests = [...requests.values()];
    const output = freezeArray(base.map((instance, index) => {
      const window = normalizedWindow(instance.finestraPartenza);
      const perNode = finestreRitornoPerNodo({
        andata: { nodes: c.nodes, legs: c.legs, finestraPartenza: window },
        ritorniPerInversione: returns,
        richieste: availableRequests.filter(r => !instance.richiestaIds.includes(r.id)),
        tolleranzaMinuti,
        bufferMinuti
      });
      const mapped = Object.freeze(Object.fromEntries([...perNode].map(([nodeId, items]) =>
        [nodeId, freezeArray(items.map(item => Object.freeze({
          ...item,
          finestraPassaggio: Object.freeze({ ...item.finestraPassaggio }),
          finestraInizioRitorno: Object.freeze({ ...item.finestraInizioRitorno }),
          richiestaIds: freezeArray(item.richiestaIds),
          richiesteSalitaNodo: freezeArray(item.richiesteSalitaNodo),
          percorsoRitorno: freezeArray(item.percorsoRitorno)
        })))])));
      return Object.freeze({ ...instance, istanzaIndice: index, finestreRitornoPerNodo: mapped });
    }));
    // Se una mutazione sincrona ha invalidato il calcolo durante il routing,
    // non restituire neppure al chiamante il risultato obsoleto.
    if (revisionOf(id) !== rev) {
      if (attempt >= 8) throw new Error("PIXEL_INCREMENTAL: lettura instabile, riprovare");
      return buildCandidatesWithReturns(id, { bufferMinuti }, complete, attempt + 1);
    }
    if (revisionOf(id) === rev) {
      if (!temporalReturnCache.has(id)) temporalReturnCache.set(id, new Map());
      temporalReturnCache.get(id).set(key, { revision: rev, value: output });
    }
    return output;
  }
  // Gruppi massimali completi e ritorni: stessa cache selettiva, chiave distinta dalla V1.
  async function temporalCandidatesCompleteWithReturns(id, options = {}) {
    return buildCandidatesWithReturns(id, options, true);
  }
  async function temporalCandidatesWithReturns(id, options = {}) {
    return buildCandidatesWithReturns(id, options, false);
  }
  function consumeOpportunityChanges() {
    const changes = freezeArray([...pendingChanges].sort().map(id => Object.freeze({
      direttriceId: id, revisione: revisionOf(id)
    })));
    pendingChanges.clear();
    return changes;
  }
  function opportunityRevision(id) {
    assert(corridors.has(id), 'direttrice sconosciuta');
    return revisionOf(id);
  }
  async function processRequestInternal(input) {
    const r = normalizeTerritorialRequest(input);
    const previous = requests.get(r.id);
    if (previous) {
      assert(JSON.stringify(previous) === JSON.stringify(r), 'ID richiesta gia presente con dati diversi');
      return Object.freeze({ azione: 'gia_presente', richiestaId: r.id,
        direttrici: freezeArray([...corridors.values()].filter(c => c.richiestaIds.includes(r.id)).map(c => c.id)) });
    }
    // Prima riutilizziamo TUTTE le direttrici gia' compatibili.
    const direct = [...corridors.values()].filter(c => containsOrdered(c.nodes, r));
    if (direct.length) {
      requests.set(r.id, r);
      for (const c of direct) corridors.set(c.id, normalizeCorridor({ ...c, richiestaIds: [...c.richiestaIds, r.id] }));
      invalidate(affectedByRequest(r));
      return Object.freeze({ azione: 'aggancio', richiestaId: r.id,
        direttrici: freezeArray(direct.map(c => c.id)) });
    }
    // Per la V1 scegliamo la prima estensione verificata in ordine deterministico.
    // Non modifichiamo la geometria di una direttrice esistente: creiamo una variante.
    for (const c of corridors.values()) {
      for (const candidate of extensionCandidates(c.nodes, r)) {
        let legs;
        try { legs = await verifiedRoute(candidate.nodes); } catch { continue; }
        const key = candidate.nodes.join('-');
        const existing = [...corridors.values()].find(x => x.nodes.join('-') === key);
        if (existing) {
          requests.set(r.id, r);
          corridors.set(existing.id, synchronizeMembership(existing));
          invalidate(affectedByRequest(r));
          return Object.freeze({ azione: 'aggancio_variante', richiestaId: r.id, direttrici: freezeArray([existing.id]) });
        }
        const id = `px-${nextId++}`;
        requests.set(r.id, r);
        corridors.set(id, normalizeCorridor({ id, nodes: candidate.nodes, legs, richiestaIds: territorialMembership(candidate.nodes) }));
        for (const other of corridors.values()) corridors.set(other.id, synchronizeMembership(other));
        invalidate(affectedByRequest(r));
        return Object.freeze({ azione: candidate.tipo, richiestaId: r.id, direttrici: freezeArray([id]), derivataDa: c.id });
      }
    }
    // Creazione solo dopo routing verificato. Nessuna mutazione in caso di errore.
    const nodes = [r.start_node_id, r.end_node_id];
    const legs = await verifiedRoute(nodes);
    const id = `px-${nextId++}`;
    requests.set(r.id, r);
    corridors.set(id, normalizeCorridor({ id, nodes, legs, richiestaIds: territorialMembership(nodes) }));
    for (const other of corridors.values()) corridors.set(other.id, synchronizeMembership(other));
    invalidate(affectedByRequest(r));
    return Object.freeze({ azione: 'creazione', richiestaId: r.id, direttrici: freezeArray([id]) });
  }
  // Serializza tutte le mutazioni asincrone: la coda prosegue anche dopo errori.
  let mutationTail = Promise.resolve();
  let mutationsPending = 0;
  function enqueueMutation(action) {
    mutationsPending++;
    const operation = mutationTail.then(action);
    mutationTail = operation.then(() => undefined, () => undefined);
    return operation.finally(() => { mutationsPending--; });
  }
  function processRequest(input) {
    return enqueueMutation(() => processRequestInternal(input));
  }
  // Variante sicura per annullamenti che devono rispettare l'ordine della coda.
  function detachRequestAsync(id) {
    return enqueueMutation(() => detachRequestInternal(id));
  }
  function mutationQueueState() {
    return Object.freeze({ pending: mutationsPending });
  }
  function detachRequest(id) {
    // Mantiene l'API V1 sincrona ma non permette un detach durante un routing
    // asincrono: usare detachRequestAsync in tale caso.
    assert(mutationsPending === 0, 'mutazione in corso: usare detachRequestAsync');
    return detachRequestInternal(id);
  }
  function detachRequestInternal(id) {
    if (!requests.has(id)) return false;
    const old = requests.get(id);
    requests.delete(id);
    for (const c of corridors.values()) if (c.richiestaIds.includes(id)) {
      corridors.set(c.id, normalizeCorridor({ ...c, richiestaIds: c.richiestaIds.filter(x => x !== id) }));
    }
    invalidate(affectedByRequest(old));
    return true; // Le direttrici spaziali restano nel catalogo.
  }
  return Object.freeze({ processRequest, listCorridors, getCorridor, getRequest, temporalCandidates, temporalCandidatesComplete, temporalCandidatesWithReturns, temporalCandidatesCompleteWithReturns, detachRequest, detachRequestAsync, mutationQueueState, consumeOpportunityChanges, opportunityRevision });
}
