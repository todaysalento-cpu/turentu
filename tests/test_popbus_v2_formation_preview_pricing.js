// TURENTU POPBUS V2 — FORMATION PREVIEW PRICING (SHADOW / NO DB)
// Test isolato: sostituisce DB, model e planner con mock in una cartella temporanea.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const sourceDir = path.join(root, 'services', 'popbus', 'v2');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'turentu-preview-shadow-'));
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log('✅ ' + label); };
try {
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"module"}');
  let preview = await fs.readFile(path.join(sourceDir, 'formation-preview.js'), 'utf8');
  preview = preview.replace("../../../db/db.js", './mock-db.js')
    .replace("./model.js", './mock-model.js')
    .replace("./planner.js", './mock-planner.js');
  await fs.writeFile(path.join(tmp, 'formation-preview.js'), preview);
  await fs.copyFile(path.join(sourceDir, 'cycle-pricing.js'), path.join(tmp, 'cycle-pricing.js'));
  await fs.writeFile(path.join(tmp, 'mock-db.js'), `
    export const pool = {query: async sql => {
      if (sql.includes('FROM richieste_pop_bus')) return {rows:[]};
      if (sql.includes('FROM nodi_direttrice')) return {rows:[
        {id:1,lat:40,lon:18},{id:2,lat:40.1,lon:18.1}
      ]};
      if (sql.includes('FROM veicolo')) return {rows:[{
        id:900,driver_id:1,posti_totali:4,euro_km:1,
        lat:40,lon:18,start:'2026-10-15T00:00:00Z',
        fine:'2026-10-19T00:00:00Z',manual:true,
        giorni_esclusi:[],inattivita:[]
      }]};
      throw Error('Query non prevista');
    }};
  `);
  await fs.writeFile(path.join(tmp, 'mock-model.js'), `
    export const generaCandidate = batch => [{seeds:[batch.at(-1).id]}];
    export const generaFormazioniAlternative = (plan,batch) => [{
      requests:[batch.at(-1)],departure:Date.parse('2026-10-16T10:00:00Z'),
      arrival:Date.parse('2026-10-16T10:20:00Z'),peak:1
    }];
  `);
  await fs.writeFile(path.join(tmp, 'mock-planner.js'), `
    export const pianifica = async () => ({nodes:[1,2],legs:[{metres:80000}]});
    export const leg = async () => ({metres:0,seconds:0});
  `);
  const { anteprimaFormazionePopbus } = await import(pathToFileURL(path.join(tmp,'formation-preview.js')));
  const base = {start_node_id:1,end_node_id:2,
    start_datetime:'2026-10-16T10:00:00Z',posti_richiesti:1};
  // Distanza commerciale 80 km, costo 80 EUR, avvicinamento e ritorno zero
  // (mock coincidente con base: test del solo calcolo monetario).
  const out90 = await anteprimaFormazionePopbus({...base,prezzi:{EXPRESS:90}});
  const r90 = out90.EXPRESS;
  check('Costo del ciclo 80 euro', () => assert.equal(r90.costo_attivazione,80));
  check('Commissione 15% su 90 euro', () => assert.equal(r90.commissione_turentu,13.5));
  check('Margine netto -3,50 euro', () => assert.equal(r90.margine_netto_con_richiesta,-3.5));
  check('Lordo 90 insufficiente dopo commissione', () => assert.equal(r90.soglia_raggiunta,false));
  check('Soglia lorda minima calcolata', () => assert.ok(r90.soglia_attivazione_lorda > 94));
  check('Deficit dopo richiesta positivo', () => assert.ok(r90.ricavo_mancante_dopo_richiesta > 4));
  check('Stato in formazione', () => assert.equal(r90.stato,'in_formazione'));
  check('Nessuna attivazione', () => assert.equal(r90.attendibilita,'indicativa'));
  const out100 = await anteprimaFormazionePopbus({...base,prezzi:{EXPRESS:100}});
  check('100 euro coprono 80 euro netti', () => assert.equal(out100.EXPRESS.soglia_raggiunta,true));
  check('Margine netto 5 euro', () => assert.equal(out100.EXPRESS.margine_netto_con_richiesta,5));
  check('Classe non richiesta rimane vuota', () => assert.equal(out100.SAVER.stato,'nessuna_formazione'));
  check('Stato soglia economica raggiunta', () => assert.equal(out100.EXPRESS.stato,'soglia_economica_raggiunta'));
  console.log(`\n✅ ${checks}/${checks} TEST SUPERATI — SHADOW, NESSUNA OPERAZIONE DB`);
} finally {
  await fs.rm(tmp,{recursive:true,force:true});
}
