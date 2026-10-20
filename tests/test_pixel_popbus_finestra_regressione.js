// TURENTU - riproduzione isolata del problema della finestra PIXEL.
// Nessun DB, nessuna API Maps, nessuna attivazione, nessuna modifica al codice.
// Eseguire dalla root: node --env-file=.env tests/test_pixel_popbus_finestra_regressione.js
import { valutaRichieste } from '../services/popbus/v2/model.js';
import { adattaOpportunitaPixel, generaFormazioniDaOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const iso = ms => new Date(ms).toISOString();
const preferred = Date.now() + 14 * 86400000;
const plan = {
  nodes: [900001, 900002],
  legs: [{ metres: 6000, seconds: 600, polyline: 'fixture-routing-verificato', roadCoincident: false }]
};
const request = {
  id: 900003,
  origine_nodo_territoriale_id: 900001,
  destinazione_nodo_territoriale_id: 900002,
  start_datetime: iso(preferred),
  posti_richiesti: 1,
  prezzo: 12,
  classe: 'STANDARD',
  stato: 'in_attesa',
  corsa_id: null
};

// La finestra PIXEL inizia un minuto DOPO la partenza preferita.
// Per la tolleranza temporale del model, un minuto dovrebbe essere ammissibile.
const windowStart = preferred + 60000;
const windowEnd = preferred + 120000;
const opportunity = {
  pixel_opportunita_id: 900004,
  pixel_direttrice_id: 900005,
  versione: 1,
  nodi: plan.nodes,
  legs: plan.legs,
  inizio_finestra: iso(windowStart),
  fine_finestra: iso(windowEnd),
  richiesta_ids: [request.id],
  dati_temporali: { fingerprint: 'fixture-finestra' }
};

try {
  const normalized = {
    ...request,
    start_node_id: request.origine_nodo_territoriale_id,
    end_node_id: request.destinazione_nodo_territoriale_id
  };
  const baseline = valutaRichieste(plan, [normalized], [request.id], { mode: 'seeds_only' });
  assert(baseline, 'Fixture non ammissibile dal modello POPBUS: verificare qualità/campi richiesti');
  assert(baseline.departure === preferred, 'Partenza baseline inattesa: ' + iso(baseline.departure));

  // Controllo di fattibilità indipendente: la partenza all'inizio della finestra
  // è a 1 minuto dall'orario desiderato e percorre la medesima tratta.
  const deltaMin = (windowStart - preferred) / 60000;
  console.log('BASELINE POPBUS:', { departure: iso(baseline.departure), richieste: baseline.requests.map(r => r.id), deltaMin });
  console.log('FINESTRA PIXEL:', { start: iso(windowStart), end: iso(windowEnd) });

  const context = adattaOpportunitaPixel(opportunity, [request]);
  const formations = generaFormazioniDaOpportunitaPixel(context);
  console.log('FORMAZIONI ADAPTER:', formations.map(f => ({ ids: f.richiesta_ids, departure: iso(f.evaluation.departure) })));

  if (formations.length === 0) {
    console.log('BUG RIPRODOTTO: il filtro a posteriori scarta la partenza preferita; occorre verificare/intersecare la finestra durante la valutazione.');
    console.log('NESSUNA MODIFICA: test diagnostico completato.');
  } else {
    console.log('BUG NON RIPRODOTTO: il caso viene già accettato; verificare la partenza e il rispetto della finestra.');
    assert(formations.every(f => f.evaluation.departure >= windowStart && f.evaluation.departure <= windowEnd), 'Partenza fuori finestra PIXEL');
  }
} catch (error) {
  console.error('TEST DIAGNOSTICO NON CONCLUSIVO:', error.stack || error.message);
  process.exitCode = 1;
}
