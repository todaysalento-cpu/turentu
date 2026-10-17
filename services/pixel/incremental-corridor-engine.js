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

export function createIncrementalCorridorEngine({ routeNodes, initialCorridors = [], tolleranzaMinuti = 30, abilitaVariantiP1 = false, maxVariantiPerRichiesta = 12, maxNodiVariante = 8 } = {}) {
  assert(typeof routeNodes === 'function', 'routeNodes obbligatoria');
  assert(Number.isFinite(tolleranzaMinuti) && tolleranzaMinuti >= 0, 'tolleranza non valida');
  assert(typeof abilitaVariantiP1 === 'boolean', 'abilitaVariantiP1 non valido');
  assert(Number.isSafeInteger(maxVariantiPerRichiesta) && maxVariantiPerRichiesta >= 1 && maxVariantiPerRichiesta <= 100, 'limite varianti non valido');
  assert(Number.isSafeInteger(maxNodiVariante) && maxNodiVariante >= 2 && maxNodiVariante <= 30, 'limite nodi non valido');
  const corridors = new Map();
  const requests = new Map();
  // P2.1: indici incrementali; le Map principali restano fonte di verita'.
  const corridorOrder = new Map();
  let corridorOrdinal = 0;
  const geometryIndex = new Map();             // nodes.join('>') -> corridor id
  const nodeCorridors = new Map();             // node id -> Set(corridor id)
  const requestsByOrigin = new Map();          // origin node -> Set(request id)
  const requestOrder = new Map();              // request id -> insertion ordinal
  let requestOrdinal = 0;
  function addRequest(r) {
    requests.set(r.id, r);
    if (!requestsByOrigin.has(r.start_node_id)) requestsByOrigin.set(r.start_node_id, new Set());
    requestsByOrigin.get(r.start_node_id).add(r.id);
    requestOrder.set(r.id, requestOrdinal++);
  }
  function removeRequest(id) {
    const r = requests.get(id);
    requests.delete(id);
    requestsByOrigin.get(r.start_node_id)?.delete(id);
    requestOrder.delete(id);
  }
  function insertCorridor(c) {
    const key = c.nodes.join('>');
    assert(!geometryIndex.has(key), 'geometria duplicata');
    corridors.set(c.id, c);
    corridorOrder.set(c.id, corridorOrdinal++);
    geometryIndex.set(key, c.id);
    for (const node of c.nodes) {
      if (!nodeCorridors.has(node)) nodeCorridors.set(node, new Set());
      nodeCorridors.get(node).add(c.id);
    }
  }
  function commonCorridors(a, b) {
    const sa = nodeCorridors.get(a), sb = nodeCorridors.get(b);
    if (!sa || !sb) return [];
    const small = sa.size <= sb.size ? sa : sb;
    const other = small === sa ? sb : sa;
    const ids = new Set([...small].filter(id => other.has(id)));
    // Ordine d'inserimento delle direttrici, come nella V1.
    return [...ids].sort((a, b) => corridorOrder.get(a) - corridorOrder.get(b)).map(id => corridors.get(id));
  }
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
    return commonCorridors(r.start_node_id, r.end_node_id).map(c => c.id);
  }
  const routeKey = nodes => nodes.join('>');
  for (const c of initialCorridors) {
    const n = normalizeCorridor(c);
    assert(!corridors.has(n.id), 'ID direttrice duplicato');
    assert(n.richiestaIds.length === 0, 'inizializzazione con richieste richiede storico esplicito');
    insertCorridor(n);
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
    const positions = new Map(nodes.map((node, i) => [node, i]));
    const matched = [];
    for (const [node, startPos] of positions) {
      for (const id of requestsByOrigin.get(node) ?? []) {
        const req = requests.get(id);
        const endPos = positions.get(req.end_node_id);
        if (endPos !== undefined && startPos < endPos) matched.push(id);
      }
    }
    // Mantiene l'ordine originale di inserimento delle richieste.
    return matched.sort((a, b) => requestOrder.get(a) - requestOrder.get(b));
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
  // P1 opt-in: composizioni di archi di domanda, non permutazioni arbitrarie.
  // Ogni arco e' una richiesta reale; ogni percorso deve contenere la nuova richiesta.
  // Il routing e' verificato prima di ogni inserimento e le geometrie sono deduplicate.
  async function generaVariantiP1(newRequestId) {
    if (!abilitaVariantiP1) return [];
    const edges = [...requests.values()];
    const adjacency = new Map();
    for (const r of edges) {
      if (!adjacency.has(r.start_node_id)) adjacency.set(r.start_node_id, []);
      adjacency.get(r.start_node_id).push(r);
    }
    const newKeys = [];
    const seen = new Set(geometryIndex.keys());
    const candidateKeys = new Set();
    const candidates = [];
    // Limiti applicati anche all'esplorazione, non solo ai risultati.
    const maxExplored = Math.max(500, maxVariantiPerRichiesta * 100);
    let explored = 0;
    function dfs(nodes, hasNew) {
      if (++explored > maxExplored) return;
      if (nodes.length >= 3 && hasNew) {
        const key = routeKey(nodes);
        if (!seen.has(key) && !candidateKeys.has(key)) {
          candidateKeys.add(key);
          candidates.push([...nodes]);
        }
      }
      if (nodes.length >= maxNodiVariante) return;
      for (const edge of adjacency.get(nodes[nodes.length - 1]) ?? []) {
        const next = edge.end_node_id;
        if (nodes.includes(next)) continue;
        dfs([...nodes, next], hasNew || edge.id === newRequestId);
        if (explored > maxExplored) return;
      }
    }
    for (const start of adjacency.keys()) {
      dfs([start], false);
      if (explored > maxExplored) break;
    }
    // Priorita' alle varianti che coprono piu' richieste, poi meno nodi.
    const scored = candidates.map(nodes => ({ nodes, score: territorialMembership(nodes).length }));
    scored.sort((a, b) => b.score - a.score || a.nodes.length - b.nodes.length || routeKey(a.nodes).localeCompare(routeKey(b.nodes)));
    for (const { nodes } of scored) {
      if (newKeys.length >= maxVariantiPerRichiesta) break;
      const key = routeKey(nodes);
      if (seen.has(key)) continue;
      let legs;
      try { legs = await verifiedRoute(nodes); } catch { continue; }
      const id = `px-${nextId++}`;
      insertCorridor(normalizeCorridor({ id, nodes, legs, richiestaIds: territorialMembership(nodes) }));
      seen.add(key);
      newKeys.push(id);
    }
    if (newKeys.length) invalidate(newKeys);
    return newKeys;
  }
  async function processRequestP1(input) {
    // La V1 rimane responsabile dell'inserimento atomico della richiesta.
    const result = await processRequestInternal(input);
    if (result.azione === 'gia_presente' || !abilitaVariantiP1) return result;
    const extra = await generaVariantiP1(result.richiestaId);
    if (!extra.length) return result;
    return Object.freeze({ ...result, direttrici: freezeArray([...new Set([...result.direttrici, ...extra])]), variantiP1: freezeArray(extra) });
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
    const direct = commonCorridors(r.start_node_id, r.end_node_id).filter(c => containsOrdered(c.nodes, r));
    if (direct.length) {
      addRequest(r);
      for (const c of direct) corridors.set(c.id, normalizeCorridor({ ...c, richiestaIds: [...c.richiestaIds, r.id] }));
      invalidate(affectedByRequest(r));
      return Object.freeze({ azione: 'aggancio', richiestaId: r.id,
        direttrici: freezeArray(direct.map(c => c.id)) });
    }
    // Per la V1 scegliamo la prima estensione verificata in ordine deterministico.
    // Non modifichiamo la geometria di una direttrice esistente: creiamo una variante.
    const extensionIds = new Set([
      ...(nodeCorridors.get(r.start_node_id) ?? []),
      ...(nodeCorridors.get(r.end_node_id) ?? [])
    ]);
    for (const c of corridors.values()) {
      if (!extensionIds.has(c.id)) continue;
      for (const candidate of extensionCandidates(c.nodes, r)) {
        let legs;
        try { legs = await verifiedRoute(candidate.nodes); } catch { continue; }
        const existingId = geometryIndex.get(routeKey(candidate.nodes));
        const existing = existingId ? corridors.get(existingId) : null;
        if (existing) {
          addRequest(r);
          corridors.set(existing.id, synchronizeMembership(existing));
          invalidate(affectedByRequest(r));
          return Object.freeze({ azione: 'aggancio_variante', richiestaId: r.id, direttrici: freezeArray([existing.id]) });
        }
        const id = `px-${nextId++}`;
        addRequest(r);
        insertCorridor(normalizeCorridor({ id, nodes: candidate.nodes, legs, richiestaIds: territorialMembership(candidate.nodes) }));
        invalidate(affectedByRequest(r));
        return Object.freeze({ azione: candidate.tipo, richiestaId: r.id, direttrici: freezeArray([id]), derivataDa: c.id });
      }
    }
    // Creazione solo dopo routing verificato. Nessuna mutazione in caso di errore.
    const nodes = [r.start_node_id, r.end_node_id];
    const legs = await verifiedRoute(nodes);
    const id = `px-${nextId++}`;
    addRequest(r);
    insertCorridor(normalizeCorridor({ id, nodes, legs, richiestaIds: territorialMembership(nodes) }));

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
    return enqueueMutation(() => processRequestP1(input));
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
    removeRequest(id);
    for (const c of commonCorridors(old.start_node_id, old.end_node_id)) if (c.richiestaIds.includes(id)) {
      corridors.set(c.id, normalizeCorridor({ ...c, richiestaIds: c.richiestaIds.filter(x => x !== id) }));
    }
    invalidate(affectedByRequest(old));
    return true; // Le direttrici spaziali restano nel catalogo.
  }
  return Object.freeze({ processRequest, listCorridors, getCorridor, getRequest, temporalCandidates, temporalCandidatesComplete, temporalCandidatesWithReturns, temporalCandidatesCompleteWithReturns, detachRequest, detachRequestAsync, mutationQueueState, consumeOpportunityChanges, opportunityRevision });
}
