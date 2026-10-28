
import { valutaCombinazioniFermate } from '../services/popbus/v2/popbus-stop-evaluator.service.js';

const BASE = Date.parse('2027-04-01T08:00:00Z');

const fermate = {
  A: { fermata_id: 101, lat: 40.10, lon: 18.10 },
  B: { fermata_id: 102, lat: 40.20, lon: 18.20 },
  C: { fermata_id: 103, lat: 40.30, lon: 18.30 }
};

const richieste = [
  {
    id: 1,
    posti_richiesti: 1,
    start_datetime: new Date(BASE).toISOString(),
    classe_percorrenza: 'MEDIA',
    max_fermate_intermedie: 5,
    min_km_tra_fermate: 0,
    max_deviazione_pct: 100
  },
  {
    id: 2,
    posti_richiesti: 1,
    start_datetime: new Date(BASE + 10 * 60000).toISOString(),
    classe_percorrenza: 'MEDIA',
    max_fermate_intermedie: 5,
    min_km_tra_fermate: 0,
    max_deviazione_pct: 100
  }
];

const combinazioni = [{
  scorePreliminare: 0,
  assegnazioni: [
    {
      richiesta_id: 1,
      start_territoriale: 0,
      end_territoriale: 2,
      salita: fermate.A,
      discesa: fermate.C
    },
    {
      richiesta_id: 2,
      start_territoriale: 1,
      end_territoriale: 2,
      salita: fermate.B,
      discesa: fermate.C
    }
  ]
}];

async function routing(a, b) {
  return {
    metres: 10000,
    seconds: 600,
    polyline: 'TEST_ROUTE'
  };
}

const risultato = await valutaCombinazioniFermate({
  combinazioni,
  richieste,
  postiTotali: 4,
  departure: BASE,
  routing
});

console.log(JSON.stringify({
  diagnostica: risultato.diagnostica,
  valide: risultato.valide.map(v => ({
    kmMissione: v.kmMissione,
    peak: v.sequenza.peak,
    visite: v.itinerario.visite.map(s => ({
      fermataId: s.fermata_id,
      arrivo: new Date(s.arrivo).toISOString(),
      eventi: s.eventi.map(e => ({
        richiestaId: e.richiesta_id,
        tipo: e.tipo
      }))
    }))
  })),
  scartate: risultato.scartate
}, null, 2));

if (risultato.valide.length !== 1) {
  throw new Error('TEST FALLITO: itinerario non valido');
}

console.log('TEST SUPERATO');
