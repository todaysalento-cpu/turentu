import assert from 'node:assert/strict';
import { generaAssegnazioniFermate } from '../services/popbus/v2/popbus-stop-assignment.service.js';

const stop = (id, tipi, distanza = 100) => ({
  fermata_id: id, lat: 40.1 + id / 10000, lon: 18.1,
  distanza_metri: distanza, tipi_veicolo_ammessi: tipi,
});
const evaluation = { requests: [{ id: 900001, start: 0, end: 1, posti_richiesti: 2 }] };
const generate = (salita, discesa, tipoVeicolo = 'ncc') =>
  generaAssegnazioniFermate({
    evaluation, tipoVeicolo, maxCombinazioni: 100,
    candidati: [{ richiesta_id: 900001, salita, discesa }],
  });

function test(name, fn) {
  try { fn(); console.log('PASS - ' + name); }
  catch (err) { console.error('FAIL - ' + name); throw err; }
}

console.log('=== POPBUS V2 - FERMATE SENZA FILTRO TIPO VEICOLO ===');

test('fermate dichiarate solo autobus accettate per NCC', () => {
  const r = generate([stop(14, ['autobus'])], [stop(15, ['autobus'])]);
  assert.equal(r.ok, true);
  assert.equal(r.combinazioni.length, 1);
  assert.equal(r.combinazioni[0].assegnazioni[0].salita.fermata_id, 14);
});

test('fermate con tipi vuoti, assenti o null accettate', () => {
  const r = generate([stop(14, []), stop(16, undefined)], [stop(15, null)]);
  assert.equal(r.ok, true);
  assert.equal(r.combinazioni.length, 2);
});

test('fermata di salita uguale alla discesa esclusa', () => {
  const r = generate([stop(14, ['autobus'])], [stop(14, ['autobus'])]);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'NESSUNA_COPPIA_FERMATE');
});

test('duplicati deduplicati usando distanza minore', () => {
  const r = generate([stop(14, ['autobus'], 300), stop(14, ['ncc'], 80)], [stop(15, [], 70)]);
  assert.equal(r.ok, true);
  assert.equal(r.combinazioni.length, 1);
  assert.equal(r.combinazioni[0].assegnazioni[0].salita.distanza_metri, 80);
});

test('coordinate non valide rifiutate', () => {
  assert.throws(() => generate([{...stop(14, []), lat: 999}], [stop(15, [])]), /fermata candidata non valida/);
});

test('tipoVeicolo resta richiesto dal contratto pubblico', () => {
  assert.throws(() => generaAssegnazioniFermate({evaluation, candidati: []}), /tipoVeicolo non valido/);
});

console.log('RISULTATO: 6 PASS attesi. Nessuna query DB; nessuna attivazione LIVE.');
