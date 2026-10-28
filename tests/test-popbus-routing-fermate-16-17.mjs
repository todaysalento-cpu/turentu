// TURENTU POPBUS V2 - TEST ROUTING FERMATE 16 -> 14/15 -> 17
// Salvare come: tests/test-popbus-routing-fermate-16-17.mjs
// Eseguire dalla root backend: node tests\test-popbus-routing-fermate-16-17.mjs
// Nessuna scrittura DB, nessuna attivazione, nessuna offerta.

import { leg } from '../services/popbus/v2/planner.js';

const fermate = Object.freeze({
  16: { id: 16, nome: 'Tricase - Stazione ferroviaria (candidata)', lat: 39.933450, lon: 18.352500 },
  14: { id: 14, nome: 'Maglie - Piazzale Megapark', lat: 40.121583, lon: 18.305914 },
  15: { id: 15, nome: 'Maglie - Stazione ferroviaria, piazzale esterno', lat: 40.1258486502909, lon: 18.299920672780097 },
  17: { id: 17, nome: 'Lecce - Stazione ferroviaria (candidata)', lat: 40.345680, lon: 18.165720 },
});

async function verificaTratta(fromId, toId) {
  const from = fermate[fromId];
  const to = fermate[toId];
  try {
    const result = await leg(from, to);
    if (!Number.isFinite(result.metres) || !Number.isFinite(result.seconds) ||
        result.metres <= 0 || result.seconds <= 0 ||
        typeof result.polyline !== 'string' || !result.polyline.length) {
      throw new Error('Routing non valido o incompleto');
    }
    return {
      da: fromId, a: toId, ok: true,
      km: Number((result.metres / 1000).toFixed(2)),
      minuti: Number((result.seconds / 60).toFixed(1)),
      geometria: true,
    };
  } catch (error) {
    return { da: fromId, a: toId, ok: false, errore: String(error?.message ?? error) };
  }
}

async function main() {
  console.log('TURENTU - DIAGNOSTICA ROUTING FERMATE REALI/CANDIDATE');
  console.log('Solo routing: nessun accesso DB, nessuna attivazione.');
  const percorsi = [[16, 14, 17], [16, 15, 17]];
  let tuttiValidi = true;
  for (const percorso of percorsi) {
    console.log(`\nPERCORSO ${percorso.join(' -> ')}`);
    const risultati = [];
    for (let i = 0; i < percorso.length - 1; i++) {
      const tratta = await verificaTratta(percorso[i], percorso[i + 1]);
      risultati.push(tratta);
      console.log(JSON.stringify(tratta));
    }
    const ok = risultati.every(r => r.ok);
    tuttiValidi &&= ok;
    console.log(JSON.stringify({
      percorso, ok,
      kmTotali: ok ? Number(risultati.reduce((sum, r) => sum + r.km, 0).toFixed(2)) : null,
      minutiTotali: ok ? Number(risultati.reduce((sum, r) => sum + r.minuti, 0).toFixed(1)) : null,
    }));
  }
  console.log(`\nESITO_ROUTING=${tuttiValidi ? 'PASS' : 'FAIL'}`);
  console.log('NOTA: PASS non certifica punto di accosto NCC, qualita, economia o attivabilita.');
  if (!tuttiValidi) process.exitCode = 1;
}

main().catch(error => {
  console.error('ERRORE TEST:', error);
  process.exitCode = 1;
});
