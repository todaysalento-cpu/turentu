import assert from 'node:assert/strict';
import test from 'node:test';
import { generaFormazioniAlternative, valutaRichieste } from '../services/popbus/v2/model.js';
import { generaFormazioniArSafe } from '../services/popbus/v2/pixel-ar-safe-formations.js';
import {
  generaFormazioniPerQuantita, indicizzaGruppiEquivalenti, riassegnaRichiesteEquivalenti
} from '../services/popbus/v2/popbus-request-groups.js';
import { generaAssegnazioniFermate } from '../services/popbus/v2/popbus-stop-assignment.service.js';

const at = time => Date.parse(`2035-11-15T${time}:00Z`);
const registro = { esclusiIds: [], arPairs: [] };
const stop = (fermata_id, distanza_metri) => ({ fermata_id, distanza_metri, lat: 40, lon: 18 });
const fermate = (id, from, to) => ({
  richiesta_id: id,
  salita: [stop(from * 10, id * 10), stop(from * 10 + 1, id * 10 + 30)],
  discesa: [stop(to * 10, id * 20)]
});
const richiesta = (id, start_node_id, end_node_id, time = '08:00') => ({
  id, start_node_id, end_node_id, start_datetime: new Date(at(time)),
  posti_richiesti: 1, prezzo: 20, ar_vincolata: false,
  cliente_id: id + 200, payment_intent_id: `pi_${id}`
});
const plan = { nodes: [1, 2, 3], legs: [
  { metres: 15000, seconds: 1200 }, { metres: 15000, seconds: 1200 }
] };
const departureWindow = { start: at('07:30'), end: at('08:30') };

test('sette richieste ordinarie equivalenti a gruppi rispettano il limite di 120', () => {
  const requests = [
    richiesta(1, 1, 2), richiesta(2, 1, 2), richiesta(3, 1, 2),
    richiesta(4, 1, 3), richiesta(5, 1, 3),
    richiesta(6, 2, 3, '08:20'), richiesta(7, 2, 3, '08:20')
  ];
  const candidati = requests.map(r => fermate(r.id, r.start_node_id, r.end_node_id));
  assert.throws(() => generaFormazioniArSafe({
    plan, requests, seeds: requests.map(r => r.id), registro,
    generaFormazioniAlternative, valutaRichieste, options: { departureWindow },
    maxFormazioni: 120
  }), /limite maxFormazioni/);

  const gruppi = indicizzaGruppiEquivalenti([{ requests }], candidati, registro);
  const { formazioni, diagnostica } = generaFormazioniPerQuantita({
    plan, requests, gruppi, departureWindow, maxFormazioni: 120
  });
  assert.equal(diagnostica.gruppi, 3);
  assert.equal(formazioni.length, 35);
  assert.equal(Math.max(...formazioni.map(f => f.peak)), 5);
  assert.ok(formazioni.some(f => f.requests.length === 7));
  assert.ok(formazioni.some(f => f.requests.map(r => r.id).join(',') === '6,7'));
  assert.ok(formazioni.every(f => f.departure === at('08:00')));
});

test('orari, fermate, quote con maggiorazione ed esposizione su più opportunità restano distinti', () => {
  const requests = [richiesta(1, 1, 3), richiesta(2, 1, 3, '08:10'), richiesta(3, 1, 3)];
  const fermateAltre = [fermate(1, 1, 3), fermate(2, 1, 3), fermate(3, 2, 3)];
  assert.equal(indicizzaGruppiEquivalenti([{ requests }], fermateAltre, registro).size, 0);
  const candidati = requests.map(r => fermate(r.id, 1, 3));
  assert.deepEqual([...indicizzaGruppiEquivalenti([{ requests }], candidati, registro).keys()], [1, 3]);
  assert.equal(indicizzaGruppiEquivalenti([{ requests }, { requests: [requests[0]] }],
    candidati, registro).size, 0);
  assert.deepEqual([...indicizzaGruppiEquivalenti(
    [{ requests }, { requests: [requests[0], requests[2]] }], candidati, registro).keys()], [1, 3]);
  requests[1].prezzo = 30;
  assert.equal(indicizzaGruppiEquivalenti([{ requests }], candidati, registro, true).size, 0);
  requests[1].ar_vincolata = true;
  assert.equal(indicizzaGruppiEquivalenti([{ requests }], candidati, registro).size, 0);
});

test('otto passeggeri flessibili generano nove ripartizioni fisiche complete', () => {
  const requests = Array.from({ length: 8 }, (_, i) => richiesta(i + 1, 1, 3));
  const candidati = requests.map(r => fermate(r.id, 1, 3));
  const gruppiEquivalenti = indicizzaGruppiEquivalenti([{ requests }], candidati, registro);
  const evaluation = { requests: requests.map(r => ({ id: r.id, start: 0, end: 2 })) };
  const precedente = generaAssegnazioniFermate({ evaluation, candidati, maxCombinazioni: 300 });
  const risultato = generaAssegnazioniFermate({ evaluation, candidati, gruppiEquivalenti });
  assert.equal(precedente.combinazioni.length, 256);
  assert.equal(risultato.diagnostica.ricercaEsaustiva, true);
  assert.equal(risultato.combinazioni.length, 9);
  assert.deepEqual(risultato.combinazioni.map(c =>
    c.assegnazioni.filter(a => a.salita.fermata_id === 10).length).sort((a, b) => a - b),
  [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('riassegna un ID libero senza duplicare richieste e conserva distanze ed eventi individuali', () => {
  const requests = [richiesta(1, 1, 3), richiesta(2, 1, 3)];
  const candidati = requests.map(r => fermate(r.id, 1, 3));
  const gruppi = indicizzaGruppiEquivalenti([{ requests }], candidati, registro);
  const perRichiesta = new Map(candidati.map(f => [f.richiesta_id, f]));
  const prima = { requests: [{ id: 1 }] };
  const seconda = {
    requests: [{ id: 1 }],
    evaluation: { requests: [{ id: 1, start: 0, end: 1 }] },
    validazioneFisica: {
      itinerario: { visite: [
        { eventi: [{ richiesta_id: 1, tipo: 'salita' }] },
        { eventi: [{ richiesta_id: 1, tipo: 'discesa' }] }
      ] },
      combinazione: { distanza_accesso_totale_metri: 30, scorePreliminare: 530,
        assegnazioni: [{ richiesta_id: 1, salita: candidati[0].salita[0], discesa: candidati[0].discesa[0] }] }
    }
  };
  const riassegnata = riassegnaRichiesteEquivalenti(prima, seconda, gruppi, perRichiesta);
  assert.equal(seconda.requests[0].id, 1);
  assert.equal(riassegnata.requests[0].id, 2);
  assert.equal(riassegnata.evaluation.requests[0].id, 2);
  assert.equal(riassegnata.validazioneFisica.itinerario.visite[0].eventi[0].richiesta_id, 2);
  assert.equal(riassegnata.validazioneFisica.combinazione.distanza_accesso_totale_metri, 60);
  assert.equal(riassegnata.validazioneFisica.combinazione.scorePreliminare, 560);
  assert.equal(riassegnaRichiesteEquivalenti({ requests: [{ id: 1 }, { id: 2 }] },
    seconda, gruppi, perRichiesta), null);
});
