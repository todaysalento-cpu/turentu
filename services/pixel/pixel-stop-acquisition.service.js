// services/pixel/pixel-stop-acquisition.service.js
// Politica temporanea Turentu: le fermate ATTIVE sono prenotabili anche se non verificate.
// Restano escluse fermate TEST, nodi inattivi ed evidenze esplicite 'non_ammessa'.
// Il campo 'verificata' NON viene modificato; Google Places resta solo discovery.
import { pool } from '../../db/db.js';
import { discoverPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';
import { discoverPixelHybridStops } from './pixel-stop-hybrid-source.service.js';
import { insertPixelStopCandidate } from './pixel-stop-budget.service.js';
import { resolveOrCreateTerritorialNode } from './pixel-territorial-node-resolver.service.js';
import { calcolaMaxFermate } from './pixel-demography.service.js';

function normalizeNodeId(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('PIXEL: nodoId non valido');
  const id = BigInt(raw);
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PIXEL: nodoId fuori intervallo');
  return raw;
}

/**
 * Stato del catalogo secondo la politica operativa provvisoria.
 * 'commerciali' indica fermate utilizzabili nella ricerca, NON certificate.
 */
export async function getPixelStopCatalogStatus(nodoId, { database = pool } = {}) {
  const id = normalizeNodeId(nodoId);
  const { rows } = await database.query(`
    WITH fermate AS (
      SELECT f.id, f.verificata,
        (
          f.attiva IS TRUE
          AND n.attivo IS TRUE
          AND f.nome !~* '^\\s*(\\[TEST PIXEL\\]|TEST PIXEL\\b)'
          AND NOT EXISTS (
            SELECT 1 FROM public.pixel_fermate_test_metadata t
            WHERE t.fermata_id = f.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.pixel_fermate_fonti ff
            WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
          )
        ) AS operativa
      FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
      WHERE f.nodo_territoriale_id = $1::bigint
    )
    SELECT COUNT(*)::integer AS censite,
      COUNT(*) FILTER (WHERE operativa)::integer AS commerciali,
      COUNT(*) FILTER (WHERE operativa AND verificata IS TRUE)::integer AS verificate_commerciali,
      COUNT(*) FILTER (WHERE operativa AND verificata IS NOT TRUE)::integer AS provvisorie_operative
    FROM fermate
  `, [id]);
  const r = rows[0] ?? {};
  const censite = Number(r.censite ?? 0);
  const commerciali = Number(r.commerciali ?? 0);
  return {
    censite,
    commerciali,
    non_ammesse: censite - commerciali,
    verificate_commerciali: Number(r.verificate_commerciali ?? 0),
    provvisorie_operative: Number(r.provvisorie_operative ?? 0),
  };
}

/**
 * Stato per Search: nessuna modifica a fermate o attestazioni.
 * Le fermate operative provvisorie sono disponibili alla ricerca.
 */
export async function ensurePixelStopsForNode(nodoId, { database = pool } = {}) {
  const id = normalizeNodeId(nodoId);
  const { rows } = await database.query(`
    SELECT id, codice_istat_comune
    FROM public.nodi_territoriali
    WHERE id = $1::bigint AND attivo = TRUE
  `, [id]);
  const node = rows[0];
  if (!node?.codice_istat_comune) {
    return {
      stato: 'nodo_non_disponibile', nodo_id: id,
      inserite: 0, ammesse: 0, pixel_fermate_disponibili: false,
    };
  }

  const catalogo = await getPixelStopCatalogStatus(id, { database });
  if (catalogo.commerciali > 0) {
    return {
      stato: 'fermate_commerciali_presenti',
      nodo_id: id,
      ...catalogo,
      inserite: 0,
      ammesse: 0,
      pixel_fermate_disponibili: true,
      politica: 'attive_anche_non_verificate',
    };
  }

  // Google Places: sola discovery, senza registrazione o attivazione.
  const plan = await discoverPixelComuneCandidates(
    String(node.codice_istat_comune), { source: 'GOOGLE', database }
  );
  const candidatiNodo = (plan.selezionati ?? []).filter(candidate =>
    (candidate.nodi_raggiungibili ?? []).some(n => String(n) === id)
  ).length;
  return {
    stato: plan.stato === 'ok' ? 'candidati_google_non_ammessi' : 'discovery_non_completa',
    nodo_id: id,
    comune: String(node.codice_istat_comune),
    ...catalogo,
    limite_comunale: plan.limite ?? null,
    budget_residuo: plan.residue ?? null,
    candidati_selezionati_per_nodo: candidatiNodo,
    errori: plan.errori ?? [],
    inserite: 0,
    ammesse: 0,
    pixel_fermate_disponibili: false,
    nota: 'Google Places usato solo per discovery; nessuna scrittura o attivazione commerciale.',
  };
}

const censimentiInCorso = new Map();
const ultimiTentativi = new Map();
const INTERVALLO_CENSIMENTO_MS = 60 * 60 * 1000;
const INTERVALLO_ERRORE_MS = 5 * 60 * 1000;

export function censisciFermateCentroPopbus(centro, { polyline, raggioMetri, database = pool } = {}) {
  return pianificaCensimento(centro.codice, centro, { polyline, raggioMetri, database });
}

export function censisciFermateEstremoPopbus(nodo, punto, { popolazione, raggioMetri, database = pool } = {}) {
  // Il fornitore riceve una zona approssimata. Il raggio esatto usa PostGIS.
  const centroRicerca = { lat: Number(punto.lat.toFixed(2)), lon: Number(punto.lon.toFixed(2)) };
  const chiave = `estremo:${nodo.id}:${centroRicerca.lat}:${centroRicerca.lon}`;
  return pianificaCensimento(chiave, { ...punto, codice: nodo.codice_istat_comune, popolazione },
    { nodoId: nodo.id, centroRicerca, raggioMetri, database });
}

async function pianificaCensimento(chiave, centro, opzioni) {
  if ((ultimiTentativi.get(chiave) ?? 0) > Date.now()) return;
  if (censimentiInCorso.has(chiave)) return censimentiInCorso.get(chiave);

  const censimento = eseguiCensimento(centro, opzioni);
  censimentiInCorso.set(chiave, censimento);
  let intervallo = INTERVALLO_CENSIMENTO_MS;
  try {
    return await censimento;
  } catch (error) {
    intervallo = INTERVALLO_ERRORE_MS;
    throw error;
  } finally {
    censimentiInCorso.delete(chiave);
    if (ultimiTentativi.size >= 1000) ultimiTentativi.delete(ultimiTentativi.keys().next().value);
    ultimiTentativi.set(chiave, Date.now() + intervallo);
  }
}

async function eseguiCensimento(centro, { polyline, raggioMetri, database, nodoId: nodoRichiesto, centroRicerca }) {
  const limiteAuto = Number.isSafeInteger(centro.popolazione) && centro.popolazione >= 0
    ? calcolaMaxFermate(centro.popolazione) : null;
  const { rows: [catalogo] } = await database.query(`
    SELECT (
      SELECT n.id FROM public.nodi_territoriali n
      WHERE n.attivo AND n.codice_istat_comune = c.codice
        AND ($5::bigint IS NULL OR n.id = $5)
      ORDER BY n.posizione <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, n.id
      LIMIT 1
    ) AS nodo_id,
    COALESCE(b.max_fermate_override, b.max_fermate_auto, $4::integer) - (
      SELECT count(*) FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
      WHERE n.codice_istat_comune = c.codice
    ) AS residue
    FROM (SELECT $1::text AS codice) c
    LEFT JOIN public.pixel_budget_comunali b ON b.codice_istat_comune = c.codice
  `, [centro.codice, centro.lon, centro.lat, limiteAuto, nodoRichiesto ?? null]);
  if (!(Number(catalogo?.residue) > 0)) return;

  let nodoId = catalogo.nodo_id;
  if (!nodoId) {
    if (nodoRichiesto) return;
    const nodo = await resolveOrCreateTerritorialNode(centro, { database });
    if (nodo?.codice_istat_comune !== centro.codice) return;
    nodoId = nodo.id;
  }
  const fonte = await discoverPixelHybridStops(nodoId, {
    database, radiusMeters: centroRicerca ? raggioMetri + 1000 : raggioMetri,
    centroRicerca, limitaAlComune: true, timeoutMs: 4500,
    overpassUrl: process.env.PIXEL_OVERPASS_URL || undefined
  });
  if (fonte.stato !== 'ok') throw new Error('Fonte OSM non disponibile per il comune ' + centro.codice);
  const candidati = fonte.candidati.filter(c => c.fonte === 'osm' && c.nome &&
    !/^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(c.nome));
  if (!candidati.length) return;

  const { rows: compatibili } = await database.query(`
    WITH area AS (
      SELECT CASE WHEN $2::text IS NOT NULL THEN ST_LineFromEncodedPolyline($2)::geography
                  ELSE ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography END AS riferimento
    )
    SELECT c.place_id
    FROM jsonb_to_recordset($1::jsonb) AS c(place_id text, lat float8, lon float8) CROSS JOIN area
    WHERE ST_DWithin(ST_SetSRID(ST_MakePoint(c.lon, c.lat), 4326)::geography,
      area.riferimento, $3)
  `, [JSON.stringify(candidati), polyline ?? null, raggioMetri, centro.lon, centro.lat]);
  const idCompatibili = new Set(compatibili.map(c => c.place_id));
  const selezionate = candidati.filter(c => idCompatibili.has(c.place_id));
  if (!selezionate.length) return;

  const client = await database.connect();
  let inserite = 0;
  try {
    await client.query('BEGIN');
    if (limiteAuto !== null) {
      await client.query(`
        INSERT INTO public.pixel_budget_comunali (codice_istat_comune, max_fermate_auto)
        VALUES ($1, $2) ON CONFLICT (codice_istat_comune) DO NOTHING
      `, [centro.codice, limiteAuto]);
    }
    for (const c of selezionate) {
      const result = await insertPixelStopCandidate({
        nodo_territoriale_id: nodoId, nome: c.nome, indirizzo: c.indirizzo, lat: c.lat, lon: c.lon
      }, { client });
      if (result.reason === 'budget_esaurito') break;
      if (!result.inserted) continue;
      await client.query(`
        INSERT INTO public.pixel_fermate_fonti
          (fermata_id, fonte, riferimento_fonte, stato_verifica, dettagli_verifica)
        VALUES ($1, 'fonte_pubblica_riutilizzabile', $2, 'da_verificare', $3::jsonb)
      `, [result.id, c.riferimento_fonte, JSON.stringify({
        origine: 'censimento_popbus', licenza: 'ODbL-1.0',
        attribuzione: 'OpenStreetMap contributors', url_attribuzione: 'https://www.openstreetmap.org/copyright'
      })]);
      inserite++;
      if (!result.budget.residue) break;
    }
    await client.query('COMMIT');
    return inserite;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
