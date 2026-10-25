// Salva come tests/test_pixel_v54_qualita_lecce.mjs
// Esegui dalla root: node --env-file=.env tests/test_pixel_v54_qualita_lecce.mjs
// SOLO LETTURA: richiama Google Places e legge PostgreSQL, senza scritture.
import { pool } from '../db/db.js';
import { discoverPixelComuneCandidates } from '../services/pixel/pixel-stop-selection-comune.service.js';
import { pixelDistanceMeters } from '../services/pixel/pixel-stop-discovery.service.js';

const ISTAT = '075035';
const MIN_METRI = 500;
const RAGGIO_TERRITORIO = 3000;
const dist = (a,b) => pixelDistanceMeters(a,b);
const round = n => Math.round(n * 10) / 10;

try {
  const r = await discoverPixelComuneCandidates(ISTAT, {
    source: 'GOOGLE', distanzaMinimaMetri: MIN_METRI,
    maxGoogleCalls: 18, maxRounds: 2,
    radiusMeters: 3000, territoryRadiusMeters: RAGGIO_TERRITORIO,
  });
  const { rows: nodes } = await pool.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE codice_istat_comune = $1 AND attivo = TRUE ORDER BY id`, [ISTAT]);
  const { rows: existing } = await pool.query(`
    SELECT f.id, f.nome, f.attiva, f.verificata,
           ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
    WHERE n.codice_istat_comune = $1`, [ISTAT]);
  const selected = r.selezionati ?? [];
  const pairs = [];
  for (let i=0; i<selected.length; i++) for (let j=i+1; j<selected.length; j++) {
    const d=dist(selected[i],selected[j]);
    pairs.push({a:selected[i].nome,b:selected[j].nome,distanza_m:round(d),violazione:d<MIN_METRI});
  }
  const collisions = [];
  for (const c of selected) for (const f of existing.filter(x=>x.attiva===true && x.verificata===true)) {
    const d=dist(c,f);
    if(d<MIN_METRI) collisions.push({candidato:c.nome,fermata_esistente:f.nome,id:f.id,distanza_m:round(d)});
  }
  const territory = selected.map(c=>{
    const nearest=nodes.map(n=>({nodo_id:n.id,nodo:n.nome,distanza_m:round(dist(c,n))})).sort((a,b)=>a.distanza_m-b.distanza_m)[0];
    return {nome:c.nome,nodo_piu_vicino:nearest?.nodo,distanza_m:nearest?.distanza_m,entro_raggio:!!nearest && nearest.distanza_m<=RAGGIO_TERRITORIO};
  });
  const classification = selected.map(c=>({
    nome:c.nome,classe:c.classe_operativa,tipo:c.tipo,
    google_primary_type:c.google_primary_type??null,
    google_types:c.google_types??[],
    priorita:c.priorita??null,
    place_id:c.place_id??null,
    lat:c.lat,lon:c.lon,
  }));
  const byClass=Object.fromEntries([...new Set(classification.map(x=>x.classe))].map(k=>[k,classification.filter(x=>x.classe===k).length]));
  const report={
    comune:ISTAT, budget:{limite:r.limite,censite:r.censite,residue:r.residue},
    selezionati:selected.length,candidati:r.candidati_distinti,riserva:r.totale_riserva,
    chiamate_google:r.discovery_progressiva?.chiamate_google_tentate,
    verifiche:{
      coppie_esaminate:pairs.length,
      distanza_minima_rilevata_m:pairs.length?round(Math.min(...pairs.map(p=>p.distanza_m))):null,
      violazioni_500m:pairs.filter(p=>p.violazione),
      conflitti_con_fermate_operative:collisions,
      fuori_raggio_territoriale:territory.filter(x=>!x.entro_raggio),
      numero_fermate_per_classe:byClass,
      controllo_budget:selected.length<=r.residue,
    },
    coppie_piu_vicine:pairs.sort((a,b)=>a.distanza_m-b.distanza_m).slice(0,12),
    classificazione_completa:classification,
    territorio:territory,
    riconciliazioni_non_operative:r.riconciliazioni_non_operative??[],
    errori:r.errori??[],
    note:['Il raggio di 3000 m non equivale ai confini amministrativi.',
      'La classificazione Google e il rispetto dei 500 m non certificano la legittimita o sicurezza di una fermata NCC.',
      'Nessuna scrittura sul database.'],
  };
  console.log(JSON.stringify(report,null,2));
} catch (e) {
  console.error('ERRORE TEST:',e);
  process.exitCode=1;
} finally { await pool.end(); }
