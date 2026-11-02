// TURENTU - test isolati del servizio REALE assegnazioni.service.js
// Salvare in tests/test_assegnazioni_conducenti.js
// Eseguire: node tests/test_assegnazioni_conducenti.js
// Nessun DB, Redis, Stripe o dato reale viene modificato.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const url = new URL('../services/conducenti/assegnazioni.service.js', import.meta.url);
const source = await readFile(url, 'utf8');
const { assegnaConducente } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const START = '2026-12-10T09:00:00+01:00';
const END = '2026-12-10T11:00:00+01:00';
const base = { operatoreId: 2, veicoloId: 364, corsaId: 923, inizio: START, fine: END };

function fakeDB(options = {}) {
  const calls = [];
  let inserted = 0;
  const client = {
    async query(sql, params = []) {
      const s = String(sql).trim();
      calls.push({ sql: s, params });
      if (s.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }] };
      if (s.includes('FROM impostazioni_assegnazione_operatori')) return { rows: [{ modalita: options.config ?? 'manuale' }] };
      if (s.includes('FROM veicolo WHERE')) return { rows: options.owner === false ? [] : [{ id: 364 }] };
      if (s.includes('FROM corse c WHERE')) return { rows: options.target === false ? [] : [{ id: 923 }] };
      if (s.includes('FROM popbus_attivazioni')) throw new Error('POPBUS non previsto');
      if (s.includes('FROM assegnazioni_conducenti') && s.includes('veicolo_id=$1')) {
        return { rows: options.vehicleBusy ? [{ id: 5 }] : [] };
      }
      if (s.includes('FROM conducenti_operatori') && s.includes('conducente_id=$2')) {
        assert.match(s, /stato='attivo'/);
        return { rows: options.associated === false ? [] : [{ id: 11 }] };
      }
      if (s.includes('FROM conducenti_operatori') && s.includes('ORDER BY conducente_id')) {
        assert.match(s, /assegnabile_automaticamente=true/, 'Automatica deve escludere conducenti non abilitati');
        return { rows: options.candidates ?? [{ conducente_id: 99, rapporto_id: 11 }] };
      }
      if (s.includes('WITH giorni AS')) {
        assert.match(s, /Europe\/Rome/);
        assert.match(s, /tipo='indisponibile'/);
        assert.match(s, /tipo='disponibile'/);
        return { rows: [{ coperto: options.covered !== false }] };
      }
      if (s.includes('FROM assegnazioni_conducenti') && s.includes('conducente_id=$1')) {
        return { rows: (options.driverBusy === true || (options.busyDrivers ?? []).includes(params[0])) ? [{ id: 8 }] : [] };
      }
      if (s.startsWith('INSERT INTO assegnazioni_conducenti')) {
        inserted++;
        return { rows: [{ id: 501, conducente_id: params[1], modalita: params[7], deroga_turno: params[8], deroga_motivo: params[9], deroga_autorizzata_da: params[10] }] };
      }
      throw new Error('SQL inattesa: ' + s.slice(0, 160));
    }
  };
  return { client, calls, get inserted() { return inserted; } };
}

async function success(label, opts, input, verify = () => {}) {
  const db = fakeDB(opts);
  const result = await assegnaConducente(db.client, { ...base, ...input });
  assert.equal(db.inserted, 1);
  verify(result, db);
  console.log('OK - ' + label);
}
async function failure(label, opts, input, code) {
  const db = fakeDB(opts);
  await assert.rejects(() => assegnaConducente(db.client, { ...base, ...input }), e => {
    assert.equal(e.code, code);
    assert.equal(e.status, 409);
    return true;
  });
  assert.equal(db.inserted, 0, 'Non deve creare assegnazioni');
  console.log('OK - ' + label);
}

await success('manuale entro turno', {}, { modalita: 'manuale', conducenteId: 99 }, r => {
  assert.equal(r.conducente_id, 99); assert.equal(r.deroga_turno, false);
});
await failure('manuale fuori turno richiede deroga', { covered: false }, { modalita: 'manuale', conducenteId: 99 }, 'CONDUCENTE_DEROGA_RICHIESTA');
await success('manuale fuori turno con deroga tracciata', { covered: false }, {
  modalita: 'manuale', conducenteId: 99, confermaDeroga: true,
  motivoDeroga: 'Servizio straordinario autorizzato', autorizzatoreId: 2
}, r => {
  assert.equal(r.deroga_turno, true);
  assert.equal(r.deroga_autorizzata_da, 2);
  assert.equal(r.deroga_motivo, 'Servizio straordinario autorizzato');
});
await failure('conflitto conducente blocca anche manuale con deroga', { covered: false, driverBusy: true }, {
  modalita: 'manuale', conducenteId: 99, confermaDeroga: true,
  motivoDeroga: 'Servizio straordinario autorizzato', autorizzatoreId: 2
}, 'CONDUCENTE_CONFLITTO');
await failure('veicolo gia occupato', { vehicleBusy: true }, { modalita: 'manuale', conducenteId: 99 }, 'CONDUCENTE_CONFLITTO');
await failure('conducente non associato', { associated: false }, { modalita: 'manuale', conducenteId: 99 }, 'CONDUCENTE_NON_DISPONIBILE');
await failure('modalita operatore diversa', { config: 'automatica' }, { modalita: 'manuale', conducenteId: 99 }, 'MODALITA_ASSEGNAZIONE_NON_CONSENTITA');
await success('automatica salta conducente occupato e sceglie successivo', {
  config: 'automatica', candidates: [{ conducente_id: 99, rapporto_id: 11 }, { conducente_id: 100, rapporto_id: 12 }], busyDrivers: [99]
}, { modalita: 'automatica' }, r => assert.equal(r.conducente_id, 100));
await failure('automatica senza copertura non assegna', { config: 'automatica', covered: false }, { modalita: 'automatica' }, 'CONDUCENTE_NON_DISPONIBILE');
await success('titolare assegnato esplicitamente', { config: 'titolare' }, { modalita: 'titolare', conducenteId: 2 }, r => assert.equal(r.conducente_id, 2));
console.log('PASS - 10 scenari del servizio reale con client PostgreSQL simulato');
console.log('NOTA - non testa i vincoli PostgreSQL reali, inclusa esclusivita conducente fra operatori.');
