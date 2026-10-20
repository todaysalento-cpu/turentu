// TURENTU - E2E PIXEL -> POPBUS V2 A/R; una transazione, rollback sempre.
// Copia diagnostica delle funzioni turno/conflitti/movement del worker (snapshot 2026-10-19).
// Non importare worker.js: puo' avviare processi e side effect.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';
import { eseguiPixelArWorkerShadow } from '../services/popbus/v2/pixel-ar-worker-shadow.js';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function minute(t) {
  const p = fmt.formatToParts(new Date(t));

  return Number(
    p.find(x => x.type === 'hour').value
  ) * 60 + Number(
    p.find(x => x.type === 'minute').value
  );
}

// I turni sono ricorrenti: la data di start/fine è solo un contenitore
// dell'orario. Gli istanti della missione sono verificati in Europe/Rome.
const giornoFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome', weekday: 'short'
});
const GIORNI = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function giornoLocale(t) {
  return GIORNI.indexOf(giornoFmt.format(new Date(t)).toLowerCase());
}

function giornoEscluso(giorni, t) {
  if (!Array.isArray(giorni) || !giorni.length) return false;
  const day = giornoLocale(t);
  const nomi = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
  return giorni.some(g => {
    const value = String(g).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Supporta 0..6 (domenica=0), 1..7 (ISO, domenica=7) e nomi.
    // Per valori numerici 1..6 le due convenzioni differiscono:
    // qui viene adottata la convenzione JavaScript 0..6.
    return value === String(day) || (day === 0 && value === '7') ||
      value === nomi[day] || value === GIORNI[day];
  });
}

function inattivo(v, a, b) {
  const periodi = v.inattivita || [];
  if (!Array.isArray(periodi) || !periodi.length) return false;
  return periodi.some(p => {
    // Se il formato non è riconosciuto, blocca per sicurezza.
    if (!p || typeof p !== 'object') return true;
    const start = p.start ?? p.inizio ?? p.dal ?? p.da;
    const end = p.fine ?? p.end ?? p.al ?? p.a;
    if (!start || !end) return true;
    const x = new Date(start).getTime();
    const y = new Date(end).getTime();
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    return x < b && y > a;
  });
}

function turno(v, a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return false;
  if (!v.start || !v.fine) return false;
  const s = minute(v.start);
  const e = minute(v.fine);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  if (inattivo(v, a, b)) return false;

  // Campionamento di ogni minuto, incluso l'ultimo minuto operativo.
  // Le esclusioni si riferiscono al giorno di inizio del turno:
  // per un turno notturno 20:00-06:00, le ore dopo mezzanotte
  // appartengono al turno iniziato il giorno precedente.
  for (let t = a; t < b; t = Math.min(b, Math.floor(t / 60000) * 60000 + 60000)) {
    const m = minute(t);
    const valido = s < e ? (m >= s && m < e) : (m >= s || m < e);
    if (!valido) return false;
    const giornoTurno = s > e && m < e ? t - 24 * 60 * 60 * 1000 : t;
    if (giornoEscluso(v.giorni_esclusi, giornoTurno)) return false;
  }
  return true;
}

// Unica fonte per la verifica iniziale e la rivalidazione finale.
// driver_id e' il TITOLARE della flotta: l'esclusivita' e' per veicolo_id.
// Le corse gia' collegate a un'attivazione sono rappresentate dalla
// relativa attivazione (che include avvicinamento e ritorno).
// Le direttrici legacy sono controllate soltanto se hanno segmenti
// temporali determinabili; quelle senza intervallo richiedono gestione
// separata, non un blocco permanente di tutti i giorni.
async function conflittiVeicolo(client, veicoloId, busyStart, busyEnd) {
  const { rows } = await client.query(`
    SELECT 'attivazione' AS origine, a.id::text AS id,
           COALESCE((a.piano->>'busyStart')::timestamptz, a.partenza) AS inizio,
           COALESCE((a.piano->>'busyEnd')::timestamptz, a.arrivo) AS fine
    FROM popbus_attivazioni a
    WHERE a.veicolo_id=$1
      AND a.stato IN ('in_attesa_autista','confermata')
      AND COALESCE((a.piano->>'busyStart')::timestamptz, a.partenza) < $3::timestamptz
      AND COALESCE((a.piano->>'busyEnd')::timestamptz, a.arrivo) > $2::timestamptz

    UNION ALL

    SELECT 'corsa' AS origine, c.id::text AS id,
           c.start_datetime AS inizio, c.arrivo_datetime AS fine
    FROM corse c
    WHERE c.veicolo_id=$1
      AND c.stato IN ('prenotabile','in_corso','da_attivare')
      AND c.start_datetime < $3::timestamptz
      AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime > $2::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM popbus_attivazioni a
        WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id
          AND a.stato IN ('in_attesa_autista','confermata')
      )

    UNION ALL

    SELECT 'direttrice' AS origine, d.id::text AS id,
           d.partenza_prevista AS inizio,
           MAX(s.start_datetime + s.tempo_stimato * INTERVAL '1 minute') AS fine
    FROM direttrici_virtuali d
    JOIN segmenti s ON s.direttrice_id=d.id
    WHERE d.veicolo_id=$1
      AND d.stato IN ('in_attesa_autista','attivo','confermata')
      AND d.partenza_prevista < $3::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM popbus_attivazioni a
        WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id
          AND a.stato IN ('in_attesa_autista','confermata')
      )
    GROUP BY d.id, d.partenza_prevista
    HAVING MAX(s.start_datetime + s.tempo_stimato * INTERVAL '1 minute') > $2::timestamptz
  `, [veicoloId, new Date(busyStart), new Date(busyEnd)]);
  return rows;
}

async function movement(a, b) {
  if (
    Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 &&
    Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7
  ) {
    return {
      metres: 0,
      seconds: 0
    };
  }

  return leg(a, b);
}



const client = await pool.connect();
let begun = false;
let failed = false;
let requestIds = [];
let opportunityIds = [];
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  begun = true;
  await client.query("SET LOCAL statement_timeout = '180s'");
  await client.query("SET LOCAL lock_timeout = '10s'");

  // Il test non puo' operare su una snapshot READ ONLY: crea fixture temporanee
  // nella propria transazione e passa SEMPRE lo stesso client al worker.
  const ids = [8, 5, 7];
  const {rows: nodes} = await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id=ANY($1::bigint[]) AND attivo=TRUE`, [ids]);
  assert.equal(nodes.length, 3, 'nodi reali 8/5/7 non disponibili');
  const byId = new Map(nodes.map(n => [Number(n.id), {...n,lat:Number(n.lat),lon:Number(n.lon)}]));
  const routeNodes = async path => {
    const legs = [];
    for(let i=1;i<path.length;i++) {
      const route=await leg(byId.get(Number(path[i-1])),byId.get(Number(path[i])));
      assert.ok(route && route.metres>0 && route.seconds>0 && route.polyline,
        `routing PIXEL non valido: ${path[i-1]} -> ${path[i]}`);
      legs.push({metres:route.metres,seconds:route.seconds,polyline:route.polyline,roadCoincident:false});
    }
    return {verificataRouting:true,legs};
  };
  // Orari futuri e lontani dal cambio DST, evitando falsi scarti 'tempo'.
  const start = new Date('2026-11-10T09:00:00+01:00');
  const retour = new Date('2026-11-10T17:00:00+01:00');
  const groupId = randomUUID();
  const cases = [
    {a:8,b:7,at:start,prezzo:35,ar:false},
    {a:8,b:7,at:new Date(start.getTime()+5*60000),prezzo:35,ar:true,tratta:'andata'},
    {a:7,b:8,at:retour,prezzo:35,ar:true,tratta:'ritorno'},
    {a:7,b:8,at:new Date(retour.getTime()+5*60000),prezzo:35,ar:false}
  ];
  for (const c of cases) {
    const a=byId.get(c.a), b=byId.get(c.b);
    const {rows} = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (origine,destinazione,origine_nodo_territoriale_id,
         destinazione_nodo_territoriale_id,origine_address,destinazione_address,
         start_datetime,posti_richiesti,stato,classe,prezzo,
         ar_group_id,ar_tratta,ar_vincolata)
      VALUES (ST_SetSRID(ST_MakePoint($1,$2),4326),
              ST_SetSRID(ST_MakePoint($3,$4),4326),
              $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10,$11,$12,$13)
      RETURNING id`,
      [a.lon,a.lat,b.lon,b.lat,c.a,c.b,a.nome,b.nome,c.at,c.prezzo,
       c.ar?groupId:null,c.ar?c.tratta:null,c.ar]);
    requestIds.push(Number(rows[0].id));
  }
  console.log('FIXTURE RICHIESTE:',JSON.stringify({requestIds,arGroupId:groupId}));
  const {rows: requests} = await client.query(
    'SELECT * FROM public.richieste_pop_bus WHERE id=ANY($1::integer[]) ORDER BY id', [requestIds]);
  assert.equal(requests.length,4);
  const engine = createIncrementalCorridorEngine({routeNodes,abilitaVariantiP1:true});
  for(const request of requests) await engine.processRequest(request);
  const corridors=engine.listCorridors();
  assert.ok(corridors.length>0,'PIXEL non ha creato direttrici');
  for(const corridor of corridors) {
    await pubblicaOpportunitaPixel({engine,direttriceId:corridor.id,bufferMinuti:0,client});
  }
  // Identificazione tramite richieste fixture, NON tramite ID assunti.
  const {rows: refs}=await client.query(`
    SELECT DISTINCT o.id FROM public.pixel_opportunita o
    JOIN public.pixel_opportunita_richieste r ON r.opportunita_id=o.id
    WHERE r.richiesta_id=ANY($1::integer[]) AND o.stato='candidata'
    ORDER BY o.id`,[requestIds]);
  opportunityIds=refs.map(r=>Number(r.id));
  assert.ok(opportunityIds.length>0,'PIXEL non ha pubblicato opportunita candidate');
  const opportunities=await leggiOpportunitaPixel({client,opportunityIds,limit:1000});
  const contexts=await leggiContestiOpportunitaPixel({client,opportunityIds,limit:1000});
  assert.equal(contexts.length,opportunities.length,'adapter perde opportunita');
  const observed=new Set(contexts.flatMap(c=>c.richiesta_ids.map(Number)));
  assert.ok(observed.has(requestIds[0]),'domanda ordinaria andata non presente in PIXEL');
  assert.ok(observed.has(requestIds[1]),'A/R andata non presente in PIXEL');
  assert.ok(observed.has(requestIds[2]),'A/R ritorno non presente in PIXEL');
  console.log('PASS PIXEL/ADAPTER:',JSON.stringify({corridors:corridors.length,opportunityIds,observed:[...observed]}));

  const result=await eseguiPixelArWorkerShadow({
    client, movement, turno, conflittiVeicolo,
    opportunityIds, now:Date.now(),
    maxOpportunita:100,maxProposte:2000,maxNodi:100000,
    maxRoutingCalls:150,enableMultiMission:true,
    preflightMultiMission:false
  });
  assert.equal(result.passed,true,'worker shadow non ha completato');
  assert.equal(result.dbWrites,0,'worker shadow dichiara scritture');
  const selected=result.scelta?.richiesteIds?.map(Number) ?? [];
  const a=selected.includes(requestIds[1]);
  const r=selected.includes(requestIds[2]);
  assert.equal(a,r,'VIOLAZIONE VINCOLO A/R: selezionata una sola tratta');
  assert.ok(selected.every(id=>observed.has(id)),'selezione fuori dalle opportunita PIXEL');
  const vehicleIds=(result.scelta?.selezionati ?? []).map(s=>Number(s.veicolo));
  console.log('PASS POPBUS SHADOW:',JSON.stringify({
    proposte:result.proposte,veicoli:result.veicoli,scarti:result.scarti,
    selected,arSelectedTogether:a&&r,vehicleIds,margine:result.scelta?.margineTotaleEuro
  }));
  // La selezione di richieste ordinarie NON e' garantita in un caso
  // antieconomico: testiamo l'assenza di violazioni, non un esito inventato.
  console.log('PIXEL_POPBUS_AR_E2E: PASS; dbWritesWorker=0; rollbackPending=true');
} catch (err) {
  failed=true;
  console.error('PIXEL_POPBUS_AR_E2E: FAIL:',err?.stack ?? err);
} finally {
  try {
    if(begun) {
      await client.query('ROLLBACK');
      console.log('ROLLBACK ESEGUITO: nessuna scrittura confermata.');
    }
  } catch(err) {
    failed=true;
    console.error('ROLLBACK FALLITO:',err?.stack ?? err);
  } finally {
    client.release();
    await pool.end();
  }
}
if(failed) process.exitCode=1;
