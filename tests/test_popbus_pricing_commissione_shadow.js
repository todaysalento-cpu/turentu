/**
 * TURENTU — PRICING COMMISSIONE 15% — SHADOW ISOLATO
 * Nessun database, nessuna chiamata Stripe, nessuna scrittura.
 * Esecuzione dalla root backend:
 * node tests/test_popbus_pricing_commissione_shadow.js --pricing=services/popbus/pricing.js
 * In alternativa: --pricing=<percorso relativo o assoluto al modulo aggiornato>
 * Il file reale viene caricato in memoria sostituendo SOLO l'import DB con un mock.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const pathArg = process.argv.find(x => x.startsWith('--pricing='))?.slice('--pricing='.length);
const candidates = [pathArg, process.env.PRICING_FILE,
  'services/popbus/pricing.js', 'services/pricing.js', 'utils/pricing.js',
  'pricing.js', 'pricing_turentu_commissione_15_tutti_tipi_aggiornato.txt'
].filter(Boolean);
const pricingPath = candidates.map(p => path.resolve(p)).find(p => fs.existsSync(p));
if (!pricingPath) {
  console.error('❌ Modulo pricing non trovato. Indicare --pricing=percorso/del/pricing.js');
  process.exit(2);
}

const vehicles = new Map([
  [101, { euro_km: 1.20, prezzo_passeggero: 3, posti: 8 }],
  [102, { euro_km: 0.80, prezzo_passeggero: 2, posti: 8 }],
  [103, { euro_km: 1.00, prezzo_passeggero: 2, posti: 4 }],
  [104, { euro_km: 2.00, prezzo_passeggero: 2, posti: 4 }],
  [105, { euro_km: 0.48, prezzo_passeggero: 2, posti: 8 }]
]);
let queries = 0;
const pool = {
  async query(sql, params = []) {
    queries++;
    const q = String(sql).toLowerCase();
    if (q.includes('from direttrici_virtuali')) {
      if (params[0] === 500) return { rows: [{ tipo_servizio: 'SAVER', veicolo_id: 105 }] };
      return { rows: [] };
    }
    if (q.includes('from tariffe t') && q.includes('join veicolo')) {
      return { rows: (params[0] || []).filter(id => vehicles.has(Number(id))).map(id => {
        const v = vehicles.get(Number(id));
        return { veicolo_id: Number(id), euro_km: v.euro_km, posti: v.posti };
      }) };
    }
    if (q.includes('from tariffe') && q.includes('where veicolo_id')) {
      const v = vehicles.get(Number(params[0]));
      return { rows: v ? [{ euro_km: v.euro_km, prezzo_passeggero: v.prezzo_passeggero }] : [] };
    }
    throw new Error('Query non autorizzata nel mock SHADOW: ' + q.slice(0, 160));
  }
};

const source = fs.readFileSync(pricingPath, 'utf8');
const importPattern = /^\s*import\s*\{\s*pool\s*\}\s*from\s*['"][^'"]+['"];?\s*$/m;
if (!importPattern.test(source)) {
  console.error('❌ Import pool non riconosciuto: test interrotto senza eseguire il modulo.');
  process.exit(2);
}
const isolated = source.replace(importPattern, 'const pool = globalThis.__TURENTU_SHADOW_POOL__;');
globalThis.__TURENTU_SHADOW_POOL__ = pool;
let pricing;
try {
  pricing = await import('data:text/javascript;base64,' + Buffer.from(isolated).toString('base64'));
} catch (e) {
  console.error('❌ Caricamento pricing fallito:', e.message);
  process.exit(2);
}
if (typeof pricing.calcolaPrezzo !== 'function') {
  console.error('❌ Export calcolaPrezzo assente.');
  process.exit(2);
}

const money = x => Number(x).toFixed(2);
const round = x => Math.round((x + Number.EPSILON) * 100) / 100;
let passed = 0, failed = 0;
const results = [];
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
async function test(name, fn) {
  try {
    await fn();
    results.push(['OK', name]); passed++;
  } catch (e) {
    results.push(['FAIL', name, e.message]); failed++;
  }
}
function checkSplit(r) {
  assert.ok(r, 'Risultato null');
  for (const key of ['prezzo', 'prezzoBase', 'compensoAutista', 'commissioneImporto', 'prezzoCommerciale']) {
    assert.ok(Number.isFinite(r[key]), `${key} assente/non finito`);
  }
  assert.equal(r.commissionePercentuale, 15);
  assert.equal(r.prezzo, r.prezzoCommerciale);
  assert.equal(round(r.compensoAutista + r.commissioneImporto), r.prezzo, 'Ripartizione non riconciliata');
  assert.equal(r.commissioneImporto, round(r.prezzo * 0.15), 'Commissione diversa dal 15%');
  assert.ok(r.compensoAutista + 0.001 >= r.prezzoBase, 'Netto autista inferiore al prezzo base');
}
const c = (extra={}) => ({ veicolo_id: 101, ...extra });
const p = (corsa,posti,tipo,km,tot=km,g=0,classe='STANDARD',avv=0,rit=0) =>
  pricing.calcolaPrezzo(corsa,posti,tipo,km,tot,g,classe,avv,rit,true);

await test('Privata: 15% incluso nel prezzo finale', async () => {
  const r = await p(c(),1,'privata',100,100,0,'STANDARD',10,20);
  checkSplit(r); assert.equal(r.kmComplessiviOperativi,130);
  assert.equal(r.prezzoBase,156); assert.equal(r.prezzo,183.53);
});
await test('Privata: 2 posti, commissione una volta sola', async () => {
  const r = await p(c(),2,'privata',100,100,0,'STANDARD',10,20);
  checkSplit(r); assert.equal(r.prezzoBase,312); assert.equal(r.prezzo,367.06);
});
await test('Condivisa: formula storica + commissione unica', async () => {
  const r = await p(c({primo_posto:1}),2,'condivisa',100,100,2,'STANDARD',10,20);
  checkSplit(r);
  assert.equal(r.prezzoBase,82.5); assert.equal(r.prezzo,97.06);
});
await test('Condivisa: il ritorno aumenta la base, non la percentuale', async () => {
  const a = await p(c({primo_posto:1}),1,'condivisa',50,50,1,'STANDARD',0,0);
  const b = await p(c({primo_posto:1}),1,'condivisa',50,50,1,'STANDARD',0,40);
  checkSplit(a); checkSplit(b); assert.ok(b.prezzoBase > a.prezzoBase);
  assert.equal(b.kmComplessiviOperativi - a.kmComplessiviOperativi,40);
});
await test('POPBUS EXPRESS: target e commissione', async () => {
  const r = await p({veicoli_pool_ids:[101]},1,'popbus',100,100,0,'EXPRESS',10,20);
  checkSplit(r); assert.equal(r.targetPasseggeri,6);
  assert.equal(r.costoMissione,156); assert.equal(r.prezzoBase,26);
  assert.equal(r.prezzo,30.59); assert.equal(r.costoCommercialeMissione,183.53);
});
await test('POPBUS STANDARD: filtro indice e scelta mezzo', async () => {
  const r = await p({veicoli_pool_ids:[101,102]},1,'popbus',100,100,0,'STANDARD',10,20);
  checkSplit(r); assert.equal(r.veicoloRiferimentoId,102);
  assert.equal(r.targetPasseggeri,8); assert.equal(r.prezzoBase,13);
  assert.equal(r.prezzo,15.30);
});
await test('POPBUS SAVER: classe da direttrice e ritorno', async () => {
  const r = await p({direttrice_id:500},1,'pop-bus',100,100,0,'STANDARD',10,20);
  checkSplit(r); assert.equal(r.veicoloRiferimentoId,105);
  assert.equal(r.targetPasseggeri,8); assert.equal(r.kmComplessiviOperativi,130);
});
await test('POPBUS: capienza insufficiente non attivabile', async () => {
  const r = await p({veicoli_pool_ids:[103]},5,'popbus',100,100,0,'EXPRESS',10,20);
  assert.equal(r,null);
});
await test('POPBUS: pool vuoto non produce prezzo', async () => {
  const r = await p({veicoli_pool_ids:[]},1,'popbus',100,100,0,'EXPRESS',10,20);
  assert.equal(r,null);
});
await test('Input: posti non validi respinti', async () => {
  assert.equal(await p(c(),-2,'privata',10),null);
});
await test('Tariffa fallback: commissione applicata', async () => {
  const r = await p({veicolo_id:999},1,'privata',10,10,0,'STANDARD',0,0);
  checkSplit(r); assert.equal(r.prezzoBase,5); assert.equal(r.prezzo,5.89);
});
await test('Ritorno e avvicinamento sono sommati una sola volta', async () => {
  const r = await p(c(),1,'privata',30,999,0,'STANDARD',15,25);
  checkSplit(r); assert.equal(r.kmComplessiviOperativi,70);
  assert.equal(r.prezzoBase,84);
});
await test('Prezzo minimo: il netto autista resta coperto', async () => {
  const r = await p(c(),1,'privata',0,0);
  checkSplit(r); assert.equal(r.prezzoBase,0.50); assert.equal(r.prezzo,0.59);
});

console.log = originalLog;
console.warn = originalWarn;
originalLog('\n===============================================');
originalLog('🧪 TURENTU PRICING — SHADOW COMMISSIONE 15%');
originalLog('===============================================');
originalLog('Modulo:', pricingPath);
originalLog('DB: MOCK | Stripe: NON CHIAMATO | Scritture: ZERO');
for (const [status,name,err] of results) originalLog(`${status==='OK'?'✅':'❌'} ${name}${err?' — '+err:''}`);
originalLog(`\nRISULTATO: ${passed}/${passed+failed} superati | ${failed} falliti | ${queries} query simulate`);
originalLog('NOTA: non certifica worker, ottimizzatore, pagamenti o database reale.');
delete globalThis.__TURENTU_SHADOW_POOL__;
process.exitCode = failed ? 1 : 0;
