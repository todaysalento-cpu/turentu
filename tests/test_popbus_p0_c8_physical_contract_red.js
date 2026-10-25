// TURENTU - RED contract test per adapter P0-C8, sola lettura.
// Eseguire dalla root del progetto: node tests/test_popbus_p0_c8_physical_contract_red.js
// Nessun import dei servizi, nessuna connessione DB, nessuna scrittura.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = 'services/popbus/v2/popbus-p0-c8-adapter.js';
const source = readFileSync(path, 'utf8');
const checks = [
  {
    label: 'V1: conserva estrazione nodi locali dal piano globale',
    pass: /nodes\s*:\s*plan\.nodes\.slice\(s,\s*e\s*\+\s*1\)/.test(source),
    baseline: true
  },
  {
    label: 'V1: conserva estrazione legs locali dal piano globale',
    pass: /legs\s*:\s*plan\.legs\.slice\(s,\s*e\)/.test(source),
    baseline: true
  },
  {
    label: 'V1: conserva id opportunita PIXEL per missione',
    pass: /pixelOpportunitaId\s*:\s*Number\(pix\.pixelOpportunitaId\)/.test(source),
    baseline: true
  },
  {
    label: 'V1: continua a imporre economia verificata',
    pass: /economia\?\.economicamenteAttivabile\s*!==\s*true/.test(source),
    baseline: true
  },
  {
    label: 'V2: riceve e valida nodiTerritoriali per ogni missione',
    pass: /pix\.nodiTerritoriali/.test(source) && /nodiTerritoriali\s*:/.test(source)
  },
  {
    label: 'V2: conserva pixelDirettriceId separato da corridoioPixelId',
    pass: /pixelDirettriceId\s*:/.test(source)
  },
  {
    label: 'V2: conserva pixelVersione per missione',
    pass: /pixelVersione\s*:/.test(source)
  },
  {
    label: 'V2: esplicita schemaVersion per la missione fisica',
    pass: /schemaVersion\s*:/.test(source)
  },
  {
    label: 'V2: esplicita tipoItinerario per la missione fisica',
    pass: /tipoItinerario\s*:/.test(source)
  }
];

console.log('=== TURENTU - ADAPTER P0-C8 CONTRATTO FISICO RED (STATICO) ===');
let baselineFail = 0, v2Fail = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'RED '} - ${c.label}`);
  if (!c.pass) c.baseline ? baselineFail++ : v2Fail++;
}
console.log(`\nV1: ${4 - baselineFail}/4 | V2: ${5 - v2Fail}/5`);
if (baselineFail) {
  console.error('ERRORE: baseline V1 non riconosciuta. Verificare versione sorgente e regex.');
  process.exitCode = 2;
} else if (v2Fail) {
  console.log('RED ATTESO: l adapter non propaga ancora il contratto territoriale V2.');
  process.exitCode = 1;
} else {
  console.log('GREEN STATICO: verificare poi i valori con test comportamentali.');
}
console.log('Solo analisi statica: DB writes 0; LIVE NO.');
