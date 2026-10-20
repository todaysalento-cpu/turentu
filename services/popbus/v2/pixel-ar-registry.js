// TURENTU — Registro A/R POPBUS, read-only, fail-closed.
// Non scrive, non modifica PIXEL, non crea direttrici o missioni.
// Chiamare dentro una transazione REPEATABLE READ READ ONLY gestita dal chiamante.
const validId = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const fail = message => { throw new Error(`PIXEL_AR_REGISTRY: ${message}`); };
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

export function costruisciRegistroAr(righeCandidate, righeGruppi) {
  if (!Array.isArray(righeCandidate) || !Array.isArray(righeGruppi)) fail('righe non valide');
  const byId = new Map();
  for (const r of righeCandidate) {
    if (!validId(r?.id) || byId.has(Number(r.id))) fail('ID candidato duplicato o invalido');
    byId.set(Number(r.id), r);
  }
  const groupRows = new Map();
  for (const r of righeGruppi) {
    if (!validId(r?.id) || !uuid(r?.ar_group_id) || r.ar_vincolata !== true) fail('riga gruppo non valida');
    const key = r.ar_group_id.toLowerCase();
    if (!groupRows.has(key)) groupRows.set(key, []);
    groupRows.get(key).push(r);
  }
  const arPairs = [], esclusiIds = new Set(), gruppiIncompleti = [], gruppiIncoerenti = [];
  const groupKeys = new Set();
  for (const r of byId.values()) {
    if (r.ar_vincolata !== true) {
      if (r.ar_vincolata !== false || r.ar_group_id != null || r.ar_tratta != null) fail(`richiesta ${r.id}: metadati ordinari incoerenti`);
      continue;
    }
    if (!uuid(r.ar_group_id) || !['andata', 'ritorno'].includes(r.ar_tratta)) fail(`richiesta ${r.id}: A/R invalida`);
    groupKeys.add(r.ar_group_id.toLowerCase());
  }
  for (const key of groupKeys) {
    const rows = groupRows.get(key) || [];
    const candidateRows = [...byId.values()].filter(r => r.ar_vincolata === true && r.ar_group_id.toLowerCase() === key);
    const a = rows.filter(r => r.ar_tratta === 'andata');
    const b = rows.filter(r => r.ar_tratta === 'ritorno');
    const valid = rows.length === 2 && a.length === 1 && b.length === 1 && a[0].id !== b[0].id &&
      rows.every(r => ['andata','ritorno'].includes(r.ar_tratta) && r.stato === 'in_attesa' && r.corsa_id == null) &&
      rows.every(r => !byId.has(Number(r.id)) || (byId.get(Number(r.id)).ar_group_id.toLowerCase() === key && byId.get(Number(r.id)).ar_tratta === r.ar_tratta));
    if (!valid) {
      candidateRows.forEach(r => esclusiIds.add(Number(r.id)));
      (rows.length !== 2 ? gruppiIncompleti : gruppiIncoerenti).push(key);
      continue;
    }
    // La controparte può esistere nel DB ma non nel batch PIXEL: in quel caso
    // la richiesta presente non può contribuire ad alcuna candidata attivabile.
    if (!byId.has(Number(a[0].id)) || !byId.has(Number(b[0].id))) {
      candidateRows.forEach(r => esclusiIds.add(Number(r.id)));
      gruppiIncompleti.push(key);
      continue;
    }
    arPairs.push({ andata: Number(a[0].id), ritorno: Number(b[0].id) });
  }
  return {
    arPairs,
    esclusiIds: [...esclusiIds].sort((a,b)=>a-b),
    gruppiIncompleti,
    gruppiIncoerenti,
    richiesteCandidateIds: [...byId.keys()].sort((a,b)=>a-b)
  };
}

// ATTENZIONE: questa funzione non apre transazioni. Il client DEVE essere
// già in una transazione REPEATABLE READ READ ONLY: stessa snapshot PIXEL.
export async function leggiRegistroAr({client, richiestaIds} = {}) {
  if (!client || typeof client.query !== 'function') fail('client obbligatorio');
  if (!Array.isArray(richiestaIds) || richiestaIds.some(x => !validId(x))) fail('richiestaIds invalidi');
  const ids = [...new Set(richiestaIds.map(Number))];
  if (!ids.length) return costruisciRegistroAr([], []);
  const a = await client.query(
    'SELECT id, ar_group_id, ar_tratta, ar_vincolata, stato, corsa_id FROM public.richieste_pop_bus WHERE id = ANY($1::integer[])', [ids]);
  if (a.rows.length !== ids.length) fail('snapshot incompleto: richieste candidate mancanti');
  const groups = [...new Set(a.rows.filter(r => r.ar_vincolata === true).map(r => r.ar_group_id))];
  const b = groups.length ? await client.query(
    'SELECT id, ar_group_id, ar_tratta, ar_vincolata, stato, corsa_id FROM public.richieste_pop_bus WHERE ar_group_id = ANY($1::uuid[])', [groups]) : {rows: []};
  return costruisciRegistroAr(a.rows, b.rows);
}

// Esclude INTERE candidate contenenti richieste A/R non verificabili.
// Non elimina passeggeri da una candidata già prezzata: per salvare la domanda
// ordinaria servono candidate alternative già ricalcolate a monte.
export function filtraCandidateAr(candidati, registro) {
  if (!Array.isArray(candidati) || !registro || !Array.isArray(registro.esclusiIds)) fail('input filtro non valido');
  const excluded = new Set(registro.esclusiIds);
  return candidati.filter(c => {
    const raw = c.richieste ?? c.evaluation?.requests;
    if (!Array.isArray(raw)) fail('candidata senza richieste');
    const ids = raw.flat(Infinity).map(r => Number(typeof r === 'object' && r !== null ? r.id : r));
    if (ids.some(id => !validId(id))) fail('ID candidata invalido');
    return !ids.some(id => excluded.has(id));
  });
}
