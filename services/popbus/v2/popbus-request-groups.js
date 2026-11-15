import { valutaRichieste } from './model.js';

const qualitaRichiesta = [
  'classe_percorrenza', 'tipo_percorrenza', 'distanza_diretta_km',
  'distanzaKmDiretta', 'distanza_km_diretta', 'tempo_diretto_secondi',
  'max_fermate_intermedie', 'min_km_tra_fermate', 'max_deviazione_pct',
  'max_ritardo_minuti'
];

function firmaFermate(fermate) {
  const ordinate = [...fermate].sort((a, b) => a.fermata_id - b.fermata_id);
  const riferimento = ordinate[0].distanza_metri;
  return ordinate.map(f => [f.fermata_id, f.lat, f.lon, f.distanza_metri - riferimento]);
}

export function indicizzaGruppiEquivalenti(contexts, fermate, registro, maggiorazioneAttiva = false) {
  const perRichiesta = new Map(fermate.map(row => [Number(row.richiesta_id), row]));
  const opportunita = new Map();
  const richieste = new Map();
  const esclusi = new Set(registro.esclusiIds.map(Number));
  const appaiati = new Set(registro.arPairs.flatMap(p => [Number(p.andata), Number(p.ritorno)]));
  const contestiIndividuali = new Set();
  for (const [indice, ctx] of contexts.entries()) {
    const individuale = ctx.requests.some(r => r.ar_vincolata !== false ||
      appaiati.has(Number(r.id)) || esclusi.has(Number(r.id)));
    for (const r of ctx.requests) {
      const id = Number(r.id);
      if (individuale) contestiIndividuali.add(id);
      if (!opportunita.has(id)) opportunita.set(id, []);
      opportunita.get(id).push(indice);
      richieste.set(id, r);
    }
  }
  const blocchiEconomici = new Map();
  if (maggiorazioneAttiva) {
    // La ripartizione in centesimi segue gli ID. Conserviamo l'ordine
    // relativo delle quote diverse anche quando sostituiamo un ID.
    let ultimo;
    let blocco = 0;
    for (const [id, r] of [...richieste].sort(([a], [b]) => a - b)) {
      const quota = JSON.stringify([r.prezzo, r.prezzo_massimo_autorizzato ?? null]);
      if (quota !== ultimo) blocco++;
      blocchiEconomici.set(id, blocco);
      ultimo = quota;
    }
  }
  const equivalenti = new Map();
  for (const [id, r] of richieste) {
    const stops = perRichiesta.get(id);
    if (contestiIndividuali.has(id) || r.ar_group_id != null ||
        !stops?.salita.length || !stops?.discesa.length ||
        !Number.isSafeInteger(Number(r.cliente_id)) || Number(r.cliente_id) <= 0 ||
        typeof r.payment_intent_id !== 'string' || !r.payment_intent_id) continue;

    // Un offset costante delle distanze non cambia la preferenza fra fermate.
    const key = JSON.stringify([
      opportunita.get(id), r.start_node_id, r.end_node_id, r.start_datetime, r.posti_richiesti,
      r.prezzo, r.prezzo_massimo_autorizzato ?? null, r.classe ?? null,
      r.conferma_entro ?? null, r.payment_intent_id.startsWith('wallet_'),
      blocchiEconomici.get(id),
      ...qualitaRichiesta.map(k => r[k] ?? null),
      firmaFermate(stops.salita), firmaFermate(stops.discesa)
    ]);
    if (!equivalenti.has(key)) equivalenti.set(key, []);
    equivalenti.get(key).push(id);
  }

  const indice = new Map();
  for (const ids of equivalenti.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => a - b);
    for (const id of ids) indice.set(id, ids);
  }
  return indice;
}

export function generaFormazioniPerQuantita({
  plan, requests, gruppi, departureWindow, maxFormazioni, maxValutazioni = 50000
}) {
  const gruppiLocali = [];
  const visti = new Set();
  for (const request of [...requests].sort((a, b) => a.id - b.id)) {
    const ids = gruppi.get(Number(request.id)) ?? [Number(request.id)];
    if (visti.has(ids[0])) continue;
    visti.add(ids[0]);
    gruppiLocali.push(ids);
  }
  const formazioni = [];
  const options = { mode: 'seeds_only', departureWindow };
  let valutazioni = 0;
  let combinazioni = 0;

  function valuta(ids, opt = options) {
    if (++valutazioni > maxValutazioni)
      throw new Error('Limite valutazioni formazioni raggruppate: nessun risultato parziale');
    return valutaRichieste(plan, requests, ids, opt);
  }

  function esplora(start, selezione) {
    for (let i = start; i < gruppiLocali.length; i++) {
      const gruppo = gruppiLocali[i];
      for (let numero = 1; numero <= gruppo.length; numero++) {
        const scelta = [...selezione, { gruppo, numero }];
        const ids = scelta.flatMap(({ gruppo, numero }) => gruppo.slice(0, numero));
        combinazioni++;
        const prima = valuta(ids, { ...options, qualityEnabled: false });
        if (!prima) break;
        const vista = new Set();
        for (const { gruppo: seed } of scelta) {
          // Conserva gli orari che potevano emergere cambiando il primo seed
          // tra i gruppi, anche se ora gli ID scelti sono rappresentativi.
          if (scelta.some(({ gruppo, numero }) =>
            gruppo !== seed && gruppo[gruppo.length - numero] < seed[0])) continue;
          const evaluation = valuta([seed[0], ...ids.filter(id => id !== seed[0])]);
          if (!evaluation || vista.has(evaluation.departure)) continue;
          if (formazioni.length >= maxFormazioni)
            throw new Error('Limite formazioni raggruppate: nessun risultato parziale');
          formazioni.push(evaluation);
          vista.add(evaluation.departure);
        }
        esplora(i + 1, scelta);
      }
    }
  }

  esplora(0, []);
  return { formazioni, diagnostica: {
    gruppi: gruppiLocali.length, richieste: requests.length,
    combinazioni, valutazioni, formazioni: formazioni.length
  } };
}

export function riassegnaRichiesteEquivalenti(prima, seconda, gruppi, fermatePerRichiesta) {
  const occupate = new Set(prima.requests.map(r => Number(r.id)));
  const preservate = new Set(seconda.requests.map(r => Number(r.id)));
  const sostituzioni = new Map();
  for (const { id: rawId } of seconda.requests) {
    const id = Number(rawId);
    if (!occupate.has(id)) continue;
    const libero = gruppi.get(id)?.find(x => !occupate.has(x) && !preservate.has(x));
    if (libero === undefined) return null;
    sostituzioni.set(id, libero);
    preservate.add(libero);
  }
  if (!sostituzioni.size) return seconda;
  const sostituisci = id => sostituzioni.get(Number(id)) ?? id;
  const aggiornaRefs = refs => refs.map(ref => ({ ...ref, id: sostituisci(ref.id) }));

  // Gli ID operativi compaiono negli eventi e nei dettagli di validazione.
  function aggiornaDettagli(value, key) {
    if (key === 'richiesta_id' || key === 'richiestaId') return sostituisci(value);
    if (key === 'richiestaIds' && Array.isArray(value)) return value.map(sostituisci);
    if (Array.isArray(value)) return value.map(item => aggiornaDettagli(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .map(([prop, item]) => [prop, aggiornaDettagli(item, prop)]));
    }
    return value;
  }
  const validazioneFisica = aggiornaDettagli(seconda.validazioneFisica);
  const combinazione = validazioneFisica?.combinazione;
  if (combinazione) {
    let distanzaAccesso = 0;
    for (const assegnazione of combinazione.assegnazioni) {
      const disponibili = fermatePerRichiesta.get(Number(assegnazione.richiesta_id));
      for (const tipo of ['salita', 'discesa']) {
        const fermata = disponibili?.[tipo].find(f => f.fermata_id === assegnazione[tipo].fermata_id);
        if (!fermata) throw new Error('Riassegnazione con fermata non raggiungibile');
        assegnazione[tipo] = fermata;
        distanzaAccesso += fermata.distanza_metri;
      }
    }
    // Conserva la penalità legata al numero di fermate.
    combinazione.scorePreliminare += distanzaAccesso - combinazione.distanza_accesso_totale_metri;
    combinazione.distanza_accesso_totale_metri = distanzaAccesso;
  }
  return {
    ...seconda,
    requests: aggiornaRefs(seconda.requests),
    evaluation: { ...seconda.evaluation, requests: aggiornaRefs(seconda.evaluation.requests) },
    validazioneFisica
  };
}
