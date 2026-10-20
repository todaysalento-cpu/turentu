// TURENTU — P0-C8.21 / diagnosi selezione PIXEL-FIRST
// Mettere in tests/ come .mjs, NON modifica file produttivi o dati DB.
// Stessi adapter, model e filtri temporali di pixel-first-multimission-service.js.
import { pool } from '../db/db.js';
import { leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';
import { leggiRegistroAr } from '../services/popbus/v2/pixel-ar-registry.js';
import { generaFormazioniArSafe } from '../services/popbus/v2/pixel-ar-safe-formations.js';
import { generaFormazioniAlternative, valutaRichieste, verificaQualitaRichieste } from '../services/popbus/v2/model.js';

const LIMIT_OPPORTUNITA = 16;  // 15 + 1, come nel servizio P0-C8.21
const MAX_FORMAZIONI = 120;
const iso = x => Number.isFinite(Number(x)) ? new Date(Number(x)).toISOString() : 'non valida';
const counts = { formate:0, future:0, fuoriFinestra:0, arrivo:0, qualita:0, coerenza:0, ammesse:0 };
const client = await pool.connect();
let tx=false;
try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  tx=true;
  const now=Date.now();
  console.log('=== P0-C8.21 / DIAGNOSI SELEZIONE / READ ONLY ===');
  console.log('ORA_UTC:',iso(now));
  const raw = await leggiOpportunitaPixel({client,limit:LIMIT_OPPORTUNITA});
  console.log('OPPORTUNITA_PIXEl_LETTE:',raw.length,'(limite 16; oltre 15 il servizio blocca)');
  console.table(raw.map(o=>({id:o.pixel_opportunita_id, direttrice:o.pixel_direttrice_id,
    richieste:o.richiesta_ids?.length ?? 0,
    finestraInizio:new Date(o.inizio_finestra).toISOString(),
    finestraFine:new Date(o.fine_finestra).toISOString(),
    finestraFutura:new Date(o.fine_finestra).getTime()>now})));
  if (raw.length>15) {
    console.log('GATE: presenti piu di 15 opportunita fra le prime 16. Il servizio dovrebbe fermarsi, senza troncamento.');
  }
  if (!raw.length) {
    console.log('ESITO: ZERO opportunita candidate nel reader PIXEL. Nessuna formazione possibile.');
  } else {
    const contexts=await leggiContestiOpportunitaPixel({client,limit:LIMIT_OPPORTUNITA});
    const ids=[...new Set(contexts.flatMap(c=>c.richiesta_ids.map(Number)))];
    const registro=await leggiRegistroAr({client,richiestaIds:ids});
    console.log('REGISTRO_AR:',JSON.stringify({esclusi:registro.esclusiIds?.length ?? 0,coppie:registro.arPairs?.length ?? 0}));
    const rows=[];
    for (const ctx of contexts) {
      let generated=0,accepted=0, old=0, out=0, badArrival=0, badQuality=0, mismatch=0;
      const {formazioni}=generaFormazioniArSafe({
        plan:ctx.plan, requests:ctx.requests,seeds:ctx.richiesta_ids,registro,
        generaFormazioniAlternative,valutaRichieste,maxSeeds:100,maxFormazioni:MAX_FORMAZIONI
      });
      generated=formazioni.length; counts.formate+=generated;
      for (const e of formazioni) {
        if (!Number.isFinite(Number(e.departure)) || !Number.isFinite(Number(e.arrival)) || e.departure<=now) {
          old++; counts.future++;continue;
        }
        if (e.departure<ctx.window.start || e.departure>ctx.window.end) {
          out++;counts.fuoriFinestra++;continue;
        }
        if (e.arrival<=e.departure) {
          badArrival++;counts.arrivo++;continue;
        }
        const selected=ctx.requests.filter(r=>e.requests.some(ref=>Number(ref.id)===Number(r.id)));
        if (selected.length!==e.requests.length) {mismatch++;counts.coerenza++;continue;}
        if (!verificaQualitaRichieste(ctx.plan,selected).ok) {badQuality++;counts.qualita++;continue;}
        accepted++;counts.ammesse++;
      }
      rows.push({opportunita:ctx.pixel_opportunita_id,richieste:ctx.requests.length,
        generate:generated,scadute:old,fuoriFinestra:out,arrivoInvalido:badArrival,
        qualita:badQuality,mismatch,ammesse:accepted});
    }
    console.table(rows);
    console.log('TOTALE_FILTRI:',JSON.stringify(counts));
  }
  const {rows:vehicles}=await client.query(`SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,
    dv.start,dv.fine,dv.giorni_esclusi,dv.inattivita,
    ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
    ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
    FROM veicolo v JOIN disponibilita_veicolo dv ON dv.veicolo_id=v.id
    JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
    WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
      AND COALESCE(dv.coord,v.coord) IS NOT NULL ORDER BY v.id`);
  console.log('CONFIGURAZIONI_VEICOLO_AMMISSIBILI:',vehicles.length,'(massimo patch 35)');
  console.table(vehicles.slice(0,20).map(v=>({id:v.id,posti:v.posti_totali,tariffa:v.euro_km,
    base: `${Number(v.lat).toFixed(5)},${Number(v.lon).toFixed(5)}`})));
  console.log('RIEPILOGO:',JSON.stringify({opportunita:raw.length,formazioniAmmesse:counts.ammesse,configVeicolo:vehicles.length,
    possibileRamoVuoto:counts.ammesse===0 || vehicles.length===0}));
} catch(error) {
  console.error('ERRORE:',error?.stack??String(error));
  process.exitCode=1;
} finally {
  try {if(tx) await client.query('ROLLBACK');} finally {client.release();await pool.end();}
  console.log('FINE READ ONLY — nessun COMMIT, nessun routing, nessuno Stripe');
}
