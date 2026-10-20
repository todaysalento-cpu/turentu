// TURENTU - PIXEL-first: diagnosi concatenazione di due missioni PIXEL.
// NON modifica il worker, NON scrive nel DB, NON esegue pagamenti o attivazioni.
// Eseguire con node --env-file=.env tests\test_pixel_ciclo_andata_ritorno_readonly.js
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const assert = (x, msg) => { if (!x) throw new Error(msg); };
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workerPath = resolve(root, 'services/popbus/v2/worker.js');
let tempDir;
try {
  assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve essere 0');
  let source = await readFile(workerPath, 'utf8');
  const start = source.indexOf('async function diagnosticaFattibilitaPixelReadOnly()');
  const end = source.indexOf('\nlet cicliAttivi', start);
  assert(start >= 0 && end > start, 'Ramo diagnostico del worker non riconosciuto');
  let diag = source.slice(start, end);
  assert(diag.includes("await client.query('BEGIN READ ONLY')") && diag.includes("await client.query('ROLLBACK')"), 'Manca transazione READ ONLY / ROLLBACK');
  assert(diag.includes('valutaEconomiaCiclo({') && diag.includes('kmRitornoBase: returnTrip.metres / 1000'), 'Contratto economia non riconosciuto');
  const needle = "if (!economia.economicamenteAttivabile) { skip('soglia_economica'); continue; }";
  const marker = 'const chosen = scegliAttivazioni(feasible);';
  assert(diag.includes(needle) && diag.includes(marker) && diag.includes('const feasible = [];'), 'Punti strumentazione cambiati');
  diag = diag.replace('const feasible = [];', `const feasible = [];
    const __pixelRejected = [];
    const __pixelMetrics = { pairsExamined: 0, disjoint: 0, temporal: 0, shift: 0, route: 0, economical: 0 };
    const __pixelPairs = [];
    const __pixelSeen = new Set();`);
  diag = diag.replace(needle, `if (!economia.economicamenteAttivabile) {
          __pixelRejected.push({ f, vehicle, approach, returnTrip, busyStart, busyEnd, economia,
            requestIds: f.selectedRequests.map(r => Number(r.id)),
            revenues: f.selectedRequests.map(r => Number(r.prezzo)) });
          skip('soglia_economica'); continue;
        }`);
  const analysis = `
    // Combinazione di missioni PIXEL gia' formate, NON creazione di direttrici.
    // Le due missioni sono ciascuna non attivabile isolatamente.
    const __pixelByVehicle = new Map();
    for (const x of __pixelRejected) {
      const id = Number(x.vehicle.id);
      if (!__pixelByVehicle.has(id)) __pixelByVehicle.set(id, []);
      __pixelByVehicle.get(id).push(x);
    }
    const __pixelRouteCache = new Map();
    for (const [vehicleId, entries] of __pixelByVehicle) {
      // Dedup di ordini alternativi con stesso insieme di richieste e stessa finestra.
      const unique = new Map();
      for (const x of entries) {
        const key = x.f.pixelOpportunitaId + '|' + [...x.requestIds].sort((a,b)=>a-b).join(',') + '|' + x.f.evaluation.departure;
        if (!unique.has(key)) unique.set(key, x);
      }
      const list = [...unique.values()].sort((a,b) => a.f.evaluation.departure - b.f.evaluation.departure);
      for (let i=0; i<list.length; i++) {
        const a = list[i];
        const aIds = new Set(a.requestIds);
        for (let j=i+1; j<list.length; j++) {
          const b = list[j];
          if (Number(a.f.pixelOpportunitaId) === Number(b.f.pixelOpportunitaId)) continue;
          __pixelMetrics.pairsExamined++;
          if (b.requestIds.some(id => aIds.has(id))) continue;
          __pixelMetrics.disjoint++;
          if (Number(b.f.evaluation.departure) < Number(a.f.evaluation.arrival)) continue;
          const fromId = Number(a.f.plan.nodes.at(-1));
          const toId = Number(b.f.plan.nodes[0]);
          const routeKey = fromId + '|' + toId;
          let connector = __pixelRouteCache.get(routeKey);
          if (!connector) {
            try {
              connector = await movement(nodeMap.get(fromId), nodeMap.get(toId));
              if (![connector.metres,connector.seconds].every(v => Number.isFinite(Number(v)) && Number(v)>=0)) throw new Error('routing invalido');
            } catch { __pixelMetrics.route++; continue; }
            __pixelRouteCache.set(routeKey, connector);
          }
          if (Number(b.f.evaluation.departure) < Number(a.f.evaluation.arrival) + Number(connector.seconds)*1000) continue;
          __pixelMetrics.temporal++;
          if (!turno(a.vehicle, a.busyStart, b.busyEnd)) continue;
          __pixelMetrics.shift++;
          const euroKm = Number(a.vehicle.euro_km);
          const kmMissioni = [a,b].reduce((s,x)=>s+x.f.plan.legs.reduce((t,l)=>t+Number(l.metres),0)/1000,0);
          const kmTrasferimenti = Number(connector.metres)/1000;
          const oreAttesa = 0; // come nel diagnostico corrente: costo attesa non configurato
          const economics = valutaEconomiaCiclo({
            ricaviRichiesteEuro: [...a.revenues, ...b.revenues],
            kmAvvicinamento: Number(a.approach.metres)/1000,
            kmMissioni, kmTrasferimenti,
            kmRitornoBase: Number(b.returnTrip.metres)/1000,
            euroKm, oreAttesa
          });
          if (economics.economicamenteAttivabile) __pixelMetrics.economical++;
          const result = {
            vehicleId, opportunita: [a.f.pixelOpportunitaId,b.f.pixelOpportunitaId],
            richiestaIds: [...a.requestIds,...b.requestIds],
            prima: { partenza: new Date(a.f.evaluation.departure).toISOString(), arrivo: new Date(a.f.evaluation.arrival).toISOString(), margineIsolatoEuro: a.economia.margineEuro },
            seconda: { partenza: new Date(b.f.evaluation.departure).toISOString(), arrivo: new Date(b.f.evaluation.arrival).toISOString(), margineIsolatoEuro: b.economia.margineEuro },
            km: economics.km, ricavoLordoEuro: economics.ricavoLordoEuro,
            commissioneTurentuEuro: economics.commissioneTurentuEuro,
            costoCompletoEuro: economics.costoCompletoEuro,
            margineEuro: economics.margineEuro,
            sogliaAttivazioneLordaEuro: economics.sogliaAttivazioneLordaEuro,
            economicamenteAttivabile: economics.economicamenteAttivabile
          };
          const signature = vehicleId + '|' + result.opportunita.join('-') + '|' + [...result.richiestaIds].sort((x,y)=>x-y).join(',');
          if (!__pixelSeen.has(signature)) {
            __pixelSeen.add(signature);
            __pixelPairs.push(result);
          }
        }
      }
    }
    __pixelPairs.sort((a,b) => b.margineEuro - a.margineEuro);
    console.log('PIXEL_CICLO_ANDATA_RITORNO_JSON:' + JSON.stringify({
      passed:true, modalita:'READ_ONLY',
      combinazioniIsolateNonAttivabili: __pixelRejected.length,
      metriche: __pixelMetrics,
      cicliDistinti: __pixelPairs.length,
      cicliAttivabili: __pixelPairs.filter(x=>x.economicamenteAttivabile).length,
      migliori: __pixelPairs.slice(0,12),
      limiti: [
        'Due formazioni PIXEL gia esistenti; non crea direttrici',
        'Controlla sequenza temporale, capacita singola e turno completo; non certifica conflitti DB o vincoli A/R',
        'Costo attesa zero come diagnostico originale; nessun addebito o scrittura',
        'Cicli candidati: non certifica selezione globale o attivazione operativa'
      ]
    }));
    `;
  diag = diag.replace(marker, analysis + '\n    ' + marker);
  source = source.slice(0,start) + diag + source.slice(end);
  const workerDir = dirname(workerPath);
  source = source.replace(/(from\s*['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_m,a,relative,z) => a + pathToFileURL(resolve(workerDir,relative)).href + z);
  const code = `const src = ${JSON.stringify(source)};\nconst url='data:text/javascript;base64,'+Buffer.from(src).toString('base64');\nconst worker=await import(url);\nawait worker.processaProposteDinamicheV2();\nconsole.log('PIXEL_CICLO_WORKER_RETURN_OK');`;
  tempDir = await mkdtemp(join(tmpdir(),'turentu-pixel-ciclo-'));
  const runner = join(tempDir,'runner.mjs');
  await writeFile(runner,code,'utf8');
  const child = spawnSync(process.execPath,[runner],{
    cwd:root, encoding:'utf8', timeout:180000, maxBuffer:20*1024*1024,
    env:{...process.env,POPBUS_PIXEL_FIRST:'0',POPBUS_PIXEL_FEASIBILITY_READONLY:'1',
      POPBUS_PIXEL_SHADOW:'0',POPBUS_PIXEL_DB_SHADOW:'0',POPBUS_PIXEL_ADAPTER_SHADOW:'0',
      POPBUS_FLEET_SHADOW:'0',POPBUS_CYCLE_DIAGNOSTICS:'0'}
  });
  if (child.stderr) process.stderr.write(child.stderr);
  assert(!child.error && child.status===0,'Worker fallito: '+(child.error?.message || child.status));
  const lines = child.stdout.split(/\r?\n/);
  const detail = lines.find(x=>x.startsWith('PIXEL_CICLO_ANDATA_RITORNO_JSON:'));
  const summary = lines.find(x=>x.startsWith('PIXEL_FEASIBILITY_READONLY_JSON:'));
  assert(detail && summary && lines.includes('PIXEL_CICLO_WORKER_RETURN_OK'),'Output diagnostico incompleto');
  const data=JSON.parse(detail.slice('PIXEL_CICLO_ANDATA_RITORNO_JSON:'.length));
  const base=JSON.parse(summary.slice('PIXEL_FEASIBILITY_READONLY_JSON:'.length));
  assert(data.combinazioniIsolateNonAttivabili === base.scarti.soglia_economica,'Scarti non coerenti');
  assert(data.migliori.every(x=>new Set(x.richiestaIds).size===x.richiestaIds.length),'Richieste duplicate');
  console.log(detail);
  console.log(summary);
  console.log('PIXEL_CICLO_ANDATA_RITORNO_READONLY_OK');
} catch(err) {
  console.error('PIXEL_CICLO_ANDATA_RITORNO_ERROR:',err.stack || err.message);
  process.exitCode=1;
} finally {
  if (tempDir) await rm(tempDir,{recursive:true,force:true});
}
