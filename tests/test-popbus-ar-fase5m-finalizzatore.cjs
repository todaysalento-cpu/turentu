'use strict';
// FASE 5M: prova locale dell'orchestrazione REALE di finalizzaAttivazioniAR.
// Legge acceptance.js senza modificarlo. Sostituisce SOLO le dipendenze:
// NON esegue convertiAttivazioneInterna reale, Stripe, PIXEL o PostgreSQL.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const file = path.resolve(process.cwd(), 'services/popbus/v2/acceptance.js');
if (!fs.existsSync(file)) throw new Error(`File non trovato: ${file}`);
const source = fs.readFileSync(file, 'utf8');
const marker = 'export async function finalizzaAttivazioniAR(';
const start = source.indexOf(marker);
if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw new Error('Finalizzatore assente o duplicato');
const after = source.slice(start).replace(/^export\s+/, '');
// Il finalizzatore deve essere l'ultima dichiarazione nel file. Fallisce chiuso.
if (!/^async function finalizzaAttivazioniAR\(/.test(after)) throw new Error('Sorgente inatteso');
const uuid = '11111111-1111-4111-8111-111111111111';
function makeScenario(failure) {
  const events = [];
  let converted = 0;
  const client = {
    async query(sql) {
      const q = String(sql).trim();
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') {
        events.push(q); return { rows: [], rowCount: 0 };
      }
      if (/^SELECT g\.id, COUNT\(r\.id\)/.test(q)) {
        events.push('VERIFY_PAIRS');
        return { rows: [{ id: uuid, totale: 2, andate: 1, ritorni: 1 }] };
      }
      if (/^UPDATE ar_gruppi SET/.test(q)) {
        events.push('UPDATE_GROUP'); return { rows: [{ id: uuid }], rowCount: 1 };
      }
      if (/^UPDATE popbus_ar_accettazioni SET/.test(q)) {
        events.push('UPDATE_ACCEPTANCES'); return { rows: [{ attivazione_id: 101 }, { attivazione_id: 102 }], rowCount: 2 };
      }
      throw new Error('Query imprevista nel mock: ' + q.slice(0, 100));
    },
    release() { events.push('RELEASE'); }
  };
  const pool = { async connect() { events.push('CONNECT'); return client; } };
  const context = {
    Map, Number, Array, Set, Error,
    preflightTransazionaleAR: async () => {
      events.push('PREFLIGHT');
      return failure === 'preflight'
        ? { stato: 'non_pronta', fase: 'preflight_transazionale', gruppi: [], attivazioniBloccate: [], anomalie: [] }
        : { stato: 'pronta', fase: 'preflight_transazionale', gruppi: [{id: uuid}], gruppiBloccati: [uuid], attivazioniBloccate: [101, 102], anomalie: [] };
    },
    verificaIdentitaOfferteAR: async () => {
      events.push('IDENTITY');
      return [
        { attivazioneId: 101, offertaId: 201, operatoreId: 2 },
        { attivazioneId: 102, offertaId: 202, operatoreId: 2 }
      ];
    },
    AR_INTERNAL: Symbol('ar-test-capability'),
    convertiAttivazioneInterna: async (_client, offertaId, _operatoreId, _scelta, capability) => {
      assert.equal(capability, context.AR_INTERNAL);
      assert.equal(_client, client);
      converted++;
      events.push('CONVERT_' + offertaId);
      if (failure === 'second' && converted === 2) throw new Error('ERRORE_INIETTATO_SECONDA_CONVERSIONE');
      return { id: 300 + converted };
    }
  };
  vm.createContext(context);
  vm.runInContext(after + '\nthis.finalizza = finalizzaAttivazioniAR;', context, { filename: file, timeout: 1000 });
  return { run: () => context.finalizza(pool, 101, new Map()), events };
}
async function main() {
  for (const [failure, label] of [['preflight','PRECHECK'], ['second','SECONDA_CONVERSIONE'], [null,'SUCCESS']]) {
    const s = makeScenario(failure);
    if (failure) await assert.rejects(s.run(), failure === 'second' ? /ERRORE_INIETTATO_SECONDA_CONVERSIONE/ : /Dipendenze A\/R non pronte/);
    else {
      const result = await s.run();
      assert.equal(result.stato, 'confermato');
      assert.equal(result.corse.length, 2);
    }
    assert.equal(s.events.filter(x => x === 'RELEASE').length, 1);
    if (failure) {
      assert.equal(s.events.filter(x => x === 'ROLLBACK').length, 1);
      assert.equal(s.events.filter(x => x === 'COMMIT').length, 0);
      assert.equal(s.events.includes('UPDATE_GROUP'), false);
    } else {
      assert.equal(s.events.filter(x => x === 'COMMIT').length, 1);
      assert.equal(s.events.filter(x => x === 'ROLLBACK').length, 0);
      assert.equal(s.events.includes('UPDATE_GROUP'), true);
      assert.equal(s.events.includes('UPDATE_ACCEPTANCES'), true);
    }
    if (failure === 'second') assert.deepEqual(s.events.filter(x => x.startsWith('CONVERT_')), ['CONVERT_201', 'CONVERT_202']);
    if (failure === 'preflight') assert.equal(s.events.some(x => x.startsWith('CONVERT_')), false);
    console.log(`PASS ${label}: ${s.events.join(' -> ')}`);
  }
  console.log('FASE 5M SUPERATA: orchestrazione verificata con mock. NON e un test E2E della conversione reale.');
}
main().catch(e => { console.error('FAIL FASE 5M:', e.stack || e); process.exitCode = 1; });
