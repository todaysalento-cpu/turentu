/**
 * TURENTU STEP 4.31 — test deterministico dei conflitti A/R.
 * Non si collega al database e non modifica alcun dato.
 * Verifica la regola temporale e i trasferimenti simulati.
 * NON certifica il coordinatore transazionale in produzione.
 */
import assert from 'node:assert/strict';

function validaMissione(m) {
  if (!Number.isSafeInteger(m.veicoloId) || m.veicoloId <= 0) {
    throw new Error('VEHICLE_ID_INVALID');
  }
  const inizio = new Date(m.inizio).getTime();
  const fine = new Date(m.fine).getTime();
  if (!Number.isFinite(inizio) || !Number.isFinite(fine) || inizio >= fine) {
    throw new Error('VEHICLE_INTERVAL_INVALID');
  }
  return { ...m, inizioMs: inizio, fineMs: fine };
}

/**
 * trasferimentoSecondi: funzione di prova che restituisce i secondi
 * necessari per andare dalla fine della prima missione all'inizio
 * della seconda. In produzione occorre routing stradale verificato.
 */
async function valutaCoppia(missioneA, missioneB, trasferimentoSecondi) {
  const a = validaMissione(missioneA);
  const b = validaMissione(missioneB);

  if (a.veicoloId !== b.veicoloId) {
    return { compatibile: true, motivo: 'VEICOLI_DIVERSI' };
  }

  if (a.inizioMs < b.fineMs && b.inizioMs < a.fineMs) {
    return { compatibile: false, motivo: 'SOVRAPPOSIZIONE' };
  }

  const [prima, dopo] = a.fineMs <= b.inizioMs ? [a, b] : [b, a];
  const disponibiliSecondi = (dopo.inizioMs - prima.fineMs) / 1000;
  const necessariSecondi = await trasferimentoSecondi(prima, dopo);

  if (!Number.isFinite(necessariSecondi) || necessariSecondi < 0) {
    return { compatibile: false, motivo: 'TRASFERIMENTO_NON_VERIFICABILE' };
  }

  return necessariSecondi <= disponibiliSecondi
    ? { compatibile: true, motivo: 'COMPATIBILE' }
    : { compatibile: false, motivo: 'TRASFERIMENTO_IMPOSSIBILE' };
}

const base = '2026-11-03';
const missione = (veicoloId, da, a) => ({
  veicoloId,
  inizio: `${base}T${da}:00+01:00`,
  fine: `${base}T${a}:00+01:00`
});

let superati = 0;
try {
  const a = missione(346, '10:00', '11:00');
  const sovrapposta = missione(346, '10:30', '11:30');
  const dopo = missione(346, '11:20', '12:20');
  const altroVeicolo = missione(347, '10:30', '11:30');

  const caso1 = await valutaCoppia(a, sovrapposta, async () => 0);
  assert.equal(caso1.compatibile, false);
  assert.equal(caso1.motivo, 'SOVRAPPOSIZIONE');
  console.log('PASS 1: sovrapposizione stesso veicolo rifiutata');
  superati++;

  const caso2 = await valutaCoppia(a, dopo, async () => 30 * 60);
  assert.equal(caso2.compatibile, false);
  assert.equal(caso2.motivo, 'TRASFERIMENTO_IMPOSSIBILE');
  console.log('PASS 2: trasferimento impossibile rifiutato');
  superati++;

  const caso3 = await valutaCoppia(a, altroVeicolo, async () => {
    throw new Error('Il routing non deve essere richiesto tra veicoli distinti');
  });
  assert.equal(caso3.compatibile, true);
  assert.equal(caso3.motivo, 'VEICOLI_DIVERSI');
  console.log('PASS 3: veicoli differenti non confliggono tra loro');
  superati++;

  const caso4 = await valutaCoppia(a, dopo, async () => Number.NaN);
  assert.equal(caso4.compatibile, false);
  assert.equal(caso4.motivo, 'TRASFERIMENTO_NON_VERIFICABILE');
  console.log('PASS 4: routing non verificabile rifiutato');
  superati++;

  console.log(`\nRisultato: ${superati}/4 test superati`);
} catch (error) {
  console.error('TEST FALLITO:', error);
  process.exitCode = 1;
}
