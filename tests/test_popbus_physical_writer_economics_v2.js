// TURENTU — test isolato della rivalidazione economica del writer fisico V2.
// Copiare questo file nella cartella tests del progetto ed eseguire con Node.
// Non apre connessioni DB e non abilita LIVE.
import assert from 'node:assert/strict';
import { rivalidaEconomiaCicloFisicoV2 } from '../services/popbus/v2/popbus-physical-writer-v2.js';

const start = Date.parse('2030-06-01T09:00:00Z');
const departure = start + 10 * 60_000;
const arrival = departure + 30 * 60_000;
const end = arrival + 10 * 60_000;

function fixture() {
  return {
    ciclo: {
      partenzaBase: start,
      ritornoBase: end,
      missioni: [{
        departure,
        arrival,
        kmMissione: 10,
        plan: { legs: [{ metres: 10_000, seconds: 1800 }] }
      }],
      routingFisico: {
        approach: { metres: 2_000, seconds: 600 },
        returnTrip: { metres: 2_000, seconds: 600 },
        waitingHours: 0
      }
    },
    richiesteBloccate: [{ id: 1, prezzo: 100 }],
    euroKm: 1,
    costoAttesaOraEuro: 0,
    altriCostiEuro: 0,
    margineMinimoEuro: 0
  };
}

function test(nome, fn) {
  try {
    fn();
    console.log(`PASS - ${nome}`);
  } catch (error) {
    console.error(`FAIL - ${nome}: ${error.message}`);
    process.exitCode = 1;
  }
}

function deveRifiutare(nome, cambia, motivo = /ciclo economicamente insufficiente/) {
  test(nome, () => {
    const dati = fixture();
    cambia(dati);
    assert.throws(() => rivalidaEconomiaCicloFisicoV2(dati), motivo);
  });
}

test('ciclo sostenibile: include avvicinamento, missione e ritorno', () => {
  const economia = rivalidaEconomiaCicloFisicoV2(fixture());
  assert.equal(economia.economicamenteAttivabile, true);
  assert.ok(economia.margineEuro > 0);
});

deveRifiutare('tariffa NCC aumentata', d => { d.euroKm = 10; });
deveRifiutare('ricavi richieste insufficienti', d => { d.richiesteBloccate[0].prezzo = 5; });
deveRifiutare('margine minimo superiore al margine disponibile', d => { d.margineMinimoEuro = 100; });
deveRifiutare('altri costi rendono il ciclo insufficiente', d => { d.altriCostiEuro = 100; });
deveRifiutare('chilometri missione discordanti dai segmenti', d => { d.ciclo.missioni[0].kmMissione = 9; }, /kmMissione discordante/);
deveRifiutare('orario ritorno incoerente', d => { d.ciclo.ritornoBase += 60_000; }, /orari di avvicinamento o ritorno incoerenti/);
deveRifiutare('attesa dichiarata discordante', d => { d.ciclo.routingFisico.waitingHours = 1; }, /attesa fisica discordante/);

if (process.exitCode) {
  console.error('RISULTATO: almeno un test fallito');
} else {
  console.log('RISULTATO: 8 test economici superati (solo funzione pura; NON certifica PostgreSQL o LIVE)');
}
