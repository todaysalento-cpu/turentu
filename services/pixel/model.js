// ============================================================
// TURENTU PIXEL — MODEL V1
// Contratti e validazione, senza DB, HTTP o effetti collaterali.
// Non genera direttrici e non assegna richieste o veicoli.
// ============================================================

export const PIXEL_MODEL_VERSION = 1;
export const DEFAULT_TIME_TOLERANCE_MINUTES = 30;

function assert(condition, message) {
  if (!condition) throw new TypeError(`PIXEL_MODEL: ${message}`);
}

function positiveId(value, name) {
  const n = Number(value);
  assert(value !== null && value !== undefined && value !== '' && Number.isSafeInteger(n) && n > 0,
    `${name} deve essere un intero positivo`);
  return n;
}

function timestamp(value, name) {
  const n = value instanceof Date ? value.getTime() :
    typeof value === 'number' ? value : Date.parse(value);
  assert(Number.isFinite(n), `${name} non valido`);
  return n;
}

function finiteNonnegative(value, name) {
  const n = Number(value);
  assert(value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n >= 0,
    `${name} deve essere non negativo`);
  return n;
}

// Input compatibile con i campi del model POPBUS V2.
// La richiesta mantiene il suo ID originale; non viene prenotata.
export function normalizzaRichiesta(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'richiesta non valida');
  const id = positiveId(input.id, 'id richiesta');
  const start_node_id = positiveId(input.start_node_id, 'start_node_id');
  const end_node_id = positiveId(input.end_node_id, 'end_node_id');
  assert(start_node_id !== end_node_id, 'origine e destinazione coincidono');
  const start_datetime_ms = timestamp(input.start_datetime, 'start_datetime');
  const posti_richiesti = positiveId(input.posti_richiesti, 'posti_richiesti');
  return Object.freeze({
    id, start_node_id, end_node_id,
    start_datetime: new Date(start_datetime_ms).toISOString(),
    start_datetime_ms, posti_richiesti,
    classe: String(input.classe || 'STANDARD').trim().toUpperCase()
  });
}

export function normalizzaNodo(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'nodo non valido');
  const id = positiveId(input.id, 'id nodo');
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  assert(input.lat !== null && input.lat !== undefined && input.lat !== '' &&
    Number.isFinite(lat) && lat >= -90 && lat <= 90, 'latitudine non valida');
  assert(input.lon !== null && input.lon !== undefined && input.lon !== '' &&
    Number.isFinite(lon) && lon >= -180 && lon <= 180, 'longitudine non valida');
  return Object.freeze({ id, lat, lon });
}

// Finestra ammissibile per l'orario di salita della singola richiesta.
// Il clustering temporale userà queste finestre, NON bucket rigidi.
export function finestraSalita(richiesta, tolleranzaMinuti = DEFAULT_TIME_TOLERANCE_MINUTES) {
  const r = normalizzaRichiesta(richiesta);
  const t = finiteNonnegative(tolleranzaMinuti, 'tolleranzaMinuti');
  const delta = t * 60_000;
  return Object.freeze({
    richiesta_id: r.id,
    inizio_ms: r.start_datetime_ms - delta,
    fine_ms: r.start_datetime_ms + delta
  });
}

// Verifica preliminare della compatibilità di più orari di salita,
// conoscendo gli offset stradali (in secondi) dal primo nodo del percorso.
// Non sostituisce la verifica definitiva di POPBUS.
export function intersezionePartenze(vincoli) {
  assert(Array.isArray(vincoli) && vincoli.length > 0, 'vincoli mancanti');
  let inizio = -Infinity;
  let fine = Infinity;
  for (const v of vincoli) {
    assert(v && typeof v === 'object', 'vincolo non valido');
    const salita = finestraSalita(v.richiesta, v.tolleranzaMinuti ?? DEFAULT_TIME_TOLERANCE_MINUTES);
    const offsetMs = finiteNonnegative(v.offsetSecondi, 'offsetSecondi') * 1000;
    inizio = Math.max(inizio, salita.inizio_ms - offsetMs);
    fine = Math.min(fine, salita.fine_ms - offsetMs);
  }
  return inizio <= fine ? Object.freeze({ inizio_ms: inizio, fine_ms: fine }) : null;
}

// Contratto di uscita del futuro corridor-generator.
// Solo percorsi verificati dal routing devono essere marcati verificati.
export function creaDirettriceCandidata({ id, nodes, legs, richiestaIds, fasciaOraria, verificataRouting = false }) {
  assert(typeof id === 'string' && id.trim().length > 0, 'id direttrice non valido');
  assert(Array.isArray(nodes) && nodes.length >= 2, 'sequenza nodi insufficiente');
  const ids = nodes.map(n => positiveId(n, 'nodo direttrice'));
  // Coerente con il planner POPBUS attuale: nodi ripetuti non supportati.
  assert(new Set(ids).size === ids.length, 'nodi ripetuti non ancora supportati');
  assert(Array.isArray(richiestaIds) && richiestaIds.length > 0, 'richieste mancanti');
  const richieste = richiestaIds.map(r => positiveId(r, 'richiesta_id'));
  assert(new Set(richieste).size === richieste.length, 'richieste duplicate');
  assert(Array.isArray(legs) && legs.length === ids.length - 1, 'tratte incoerenti');
  const tratte = legs.map((l, i) => {
    assert(l && typeof l === 'object', `tratta ${i} non valida`);
    const metres = finiteNonnegative(l.metres, `tratta ${i}.metres`);
    const seconds = finiteNonnegative(l.seconds, `tratta ${i}.seconds`);
    assert((metres > 0 && seconds > 0) ||
      (metres === 0 && seconds === 0 && l.roadCoincident === true),
      `tratta ${i} senza routing valido`);
    return Object.freeze({ metres, seconds, roadCoincident: l.roadCoincident === true,
      ...(typeof l.polyline === 'string' ? { polyline: l.polyline } : {}) });
  });
  assert(fasciaOraria && typeof fasciaOraria === 'object', 'fascia oraria mancante');
  const inizio = timestamp(fasciaOraria.inizio, 'fasciaOraria.inizio');
  const fine = timestamp(fasciaOraria.fine, 'fasciaOraria.fine');
  assert(inizio <= fine, 'fascia oraria invertita');
  assert(typeof verificataRouting === 'boolean', 'verificataRouting non booleano');
  // Una dichiarazione verificata richiede geometrie stradali per ogni tratta.
  if (verificataRouting) assert(tratte.every(l => typeof l.polyline === 'string' && l.polyline.length > 0),
    'geometria stradale mancante');
  return Object.freeze({
    id, nodes: Object.freeze(ids), legs: Object.freeze(tratte),
    richiestaIds: Object.freeze(richieste),
    fasciaOraria: Object.freeze({ inizio: new Date(inizio).toISOString(), fine: new Date(fine).toISOString() }),
    verificataRouting,
    distanza_metri: tratte.reduce((s, l) => s + l.metres, 0),
    durata_secondi: tratte.reduce((s, l) => s + l.seconds, 0),
    stato: 'candidata'
  });
}
