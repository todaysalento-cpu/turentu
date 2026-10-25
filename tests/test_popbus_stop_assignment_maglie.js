
import assert from 'node:assert/strict';
import { generaAssegnazioniFermate } from '../services/popbus/v2/popbus-stop-assignment.service.js';

const fermata14 = {
  fermata_id: 14,
  nome: 'Maglie - Piazzale Megapark',
  lat: 40.121583,
  lon: 18.305914,
  distanza_metri: 120,
  tipi_veicolo_ammessi: []
};

const fermata15 = {
  fermata_id: 15,
  nome: 'Maglie - Stazione ferroviaria, piazzale esterno',
  lat: 40.1258486502909,
  lon: 18.299920672780097,
  distanza_metri: 180,
  tipi_veicolo_ammessi: []
};

// Dati sintetici in memoria: nessuna richiesta viene inserita nel DB.
const evaluation = {
  requests: [
    {
      id: 900001,
      start: 0,
      end: 1,
      posti_richiesti: 1
    }
  ]
};

const candidati = [
  {
    richiesta_id: 900001,
    salita: [fermata14],
    discesa: [fermata15]
  }
];

console.log('=== TEST POPBUS STOP ASSIGNMENT ===');
console.log('Modalità: test isolato, nessuna scrittura DB');
console.log('Distanza geodetica reale tra le fermate: 696,65 m');
console.log('Distanze di accesso usate nel test: sintetiche');

const risultato = generaAssegnazioniFermate({
  evaluation,
  candidati,
  tipoVeicolo: 'ncc'
});

assert.equal(risultato.ok, true, 'La generazione deve riuscire');
assert.equal(risultato.stato, 'DA_VALIDARE_SU_STRADA');
assert.ok(risultato.combinazioni.length > 0);

const prima = risultato.combinazioni[0];
assert.equal(prima.assegnazioni.length, 1);
assert.equal(prima.assegnazioni[0].salita.fermata_id, 14);
assert.equal(prima.assegnazioni[0].discesa.fermata_id, 15);
assert.equal(prima.fermate_distinte, 2);

console.log('\nPASS: assegnazione generata correttamente');
console.dir({
  stato: risultato.stato,
  salita: prima.assegnazioni[0].salita.fermata_id,
  discesa: prima.assegnazioni[0].discesa.fermata_id,
  fermate_distinte: prima.fermate_distinte,
  distanza_accesso_totale_metri:
    prima.distanza_accesso_totale_metri,
  diagnostica: risultato.diagnostica
}, { depth: null });
