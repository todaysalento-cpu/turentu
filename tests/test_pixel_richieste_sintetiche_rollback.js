// Destinazione: tests/test_pixel_richieste_sintetiche_rollback.js
// Esecuzione: node --env-file=.env tests\test_pixel_richieste_sintetiche_rollback.js
// Inserisce 3 richieste sintetiche nella STESSA transazione usata dal bootstrap.
// ROLLBACK SEMPRE: nessuna richiesta, direttrice o opportunita rimane nel DB.
// Non richiama pubblicaOpportunitaPixel: la versione del servizio che abbiamo
// esaminato apre una connessione separata e fa COMMIT autonomamente.
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { diagnosticaBootstrapPixel } from '../services/pixel/pixel.orchestrator.service.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(`TEST PIXEL SINTETICO: ${message}`);
};
const NODI = [8, 5, 7]; // Tricase -> Maglie -> Lecce (catalogo di test gia usato)
const day = new Date(Date.now() + 14 * 86400000);
day.setUTCHours(9, 0, 0, 0);
let client;
let transactionStarted = false;
let failed = false;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '10s'");

  const { rows: nodes } = await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id = ANY($1::bigint[]) AND attivo = TRUE`, [NODI]);
  assert(nodes.length === NODI.length,
    `servono i nodi territoriali attivi ${NODI.join(', ')}; trovati ${nodes.map(n => n.id).join(', ')}`);
  const byId = new Map(nodes.map(n => [Number(n.id), {
    ...n, lat: Number(n.lat), lon: Number(n.lon)
  }]));

  // L'orario di salita a Maglie coincide con l'arrivo teorico della prima richiesta.
  // In tal modo la compatibilita temporale e verificata sul punto di salita,
  // non confrontando semplicemente gli orari di partenza.
  const firstLeg = await leg(byId.get(8), byId.get(5));
  assert(firstLeg && Number.isFinite(firstLeg.seconds) && firstLeg.seconds > 0,
    'routing stradale Tricase -> Maglie non disponibile');
  const departureB = new Date(day.getTime() + Math.round(firstLeg.seconds) * 1000);
  const cases = [
    { a: 8, b: 5, at: day, prezzo: 7 },
    { a: 5, b: 7, at: departureB, prezzo: 9 },
    { a: 8, b: 7, at: day, prezzo: 14 }
  ];
  const inserted = [];
  for (const c of cases) {
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    const { rows } = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (origine, destinazione, origine_nodo_territoriale_id,
         destinazione_nodo_territoriale_id, origine_address,
         destinazione_address, start_datetime, posti_richiesti,
         stato, classe, prezzo)
      VALUES
        (ST_SetSRID(ST_MakePoint($1,$2),4326),
         ST_SetSRID(ST_MakePoint($3,$4),4326),
         $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10)
      RETURNING id`, [a.lon, a.lat, b.lon, b.lat,
      c.a, c.b, a.nome ?? `Nodo ${c.a}`, b.nome ?? `Nodo ${c.b}`, c.at, c.prezzo]);
    inserted.push(Number(rows[0].id));
  }
  console.log('RICHIESTE SINTETICHE (non confermate):', inserted);
  console.log('PARTENZE:', cases.map(c => ({ tratta: `${c.a}>${c.b}`, orario: c.at.toISOString() })));

  // Il bootstrap usa lo stesso client e vede le richieste non committate.
  const report = await diagnosticaBootstrapPixel({
    client, maxRichieste: 100, maxDirettrici: 500,
    abilitaVariantiP1: true, bufferMinuti: 0
  });
  console.log('PIXEL BOOTSTRAP:', JSON.stringify(report, null, 2));
  assert(report.richiesteEsaminate === 3, 'il bootstrap non ha letto le tre richieste');
  assert(report.nuoveDirettrici >= 1, 'PIXEL non ha generato direttrici');
  const composed = report.opportunita.find(o => o.nodes.join('>') === '8>5>7');
  assert(composed, 'P1 non ha generato la direttrice composta 8>5>7');
  assert(inserted.every(id => composed.richiestaIds.includes(id)),
    'la direttrice composta non include tutte e tre le richieste territorialmente compatibili');
  assert(composed.gruppiTemporali >= 1,
    'nessuna istanza temporale sulla direttrice composta');

  // Ripetizione a catalogo DB invariato: verifica risultato stabile del bootstrap.
  const second = await diagnosticaBootstrapPixel({
    client, maxRichieste: 100, maxDirettrici: 500,
    abilitaVariantiP1: true, bufferMinuti: 0
  });
  assert(second.richiesteEsaminate === report.richiesteEsaminate,
    'secondo bootstrap: numero richieste differente');
  assert(second.direttriciRisultanti === report.direttriciRisultanti,
    'secondo bootstrap: numero direttrici differente');
  assert(second.opportunitaCandidate === report.opportunitaCandidate,
    'secondo bootstrap: opportunita temporali differenti');
  console.log('TEST OK:', {
    richieste: inserted.length,
    direttrici: report.direttriciRisultanti,
    variantiP1: report.elaborazioni.flatMap(e => e.variantiP1).length,
    opportunitaTemporali: report.opportunitaCandidate,
    direttriceComposta: composed.nodes,
    richiesteAssociate: composed.richiestaIds,
    bootstrapRipetibile: true
  });
} catch (error) {
  failed = true;
  console.error('TEST FALLITO:', error.stack || error.message);
} finally {
  if (client) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK ESEGUITO: nessuna richiesta sintetica confermata.');
      } catch (error) {
        failed = true;
        console.error('ERRORE ROLLBACK:', error.stack || error.message);
      }
    }
    client.release();
  }
  await pool.end();
}
if (failed) process.exitCode = 1;
