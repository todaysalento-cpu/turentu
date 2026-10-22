// Acquisizione OSM per collaudo: nessuna fermata viene verificata o attivata.
// Non importare Google Places. Eseguire solo con CLI esplicita e Stripe TEST.
import { pool } from '../../db/db.js';
import { discoverPixelHybridStops } from './pixel-stop-hybrid-source.service.js';
import { selectPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';

const CITIES = Object.freeze({ '072006': 'Bari', '073027': 'Taranto' });
const validId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;

async function discoverComune(istat) {
  if (!Object.hasOwn(CITIES, istat)) throw new Error('Comune non autorizzato al collaudo');
  const { rows: nodes } = await pool.query(`
    SELECT id, codice_istat_comune FROM public.nodi_territoriali
    WHERE codice_istat_comune = $1 AND attivo = TRUE ORDER BY id`, [istat]);
  if (!nodes.length) throw new Error(`Nessun nodo attivo per ${istat}`);
  const { rows: budgets } = await pool.query(`
    SELECT COALESCE(max_fermate_override, max_fermate_auto) AS limite
    FROM public.pixel_budget_comunali WHERE codice_istat_comune=$1`, [istat]);
  if (!budgets.length) throw new Error(`Budget assente per ${istat}`);
  const { rows: counts } = await pool.query(`
    SELECT COUNT(*)::int AS censite FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
    WHERE n.codice_istat_comune=$1`, [istat]);
  const limite = Number(budgets[0].limite);
  const censite = Number(counts[0].censite);
  const residue = Math.max(0, limite - censite);
  if (!residue) return { comune: CITIES[istat], istat, limite, censite, residue, selezionati: [], errori: [] };

  const risultati = [];
  for (const n of nodes) {
    const result = await discoverPixelHybridStops(n.id, { radiusMeters: 3000 });
    risultati.push({ ...result, radiusMeters: 3000 });
  }
  const errori = risultati.flatMap(r => r.errori ?? []);
  // Non procedere su risultati parziali: un guasto Overpass non deve
  // trasformarsi in un catalogo apparentemente completo.
  if (errori.length) throw new Error(`Discovery incompleta per ${istat}: ${JSON.stringify(errori)}`);
  const scelta = selectPixelComuneCandidates(risultati, residue);
  const selezionati = scelta.selezionati
    .filter(c => c.fonte === 'osm' && /^osm:(node|way|relation):\d+$/.test(String(c.place_id)))
    .map(c => {
      const nodi = c.nodi_raggiungibili ?? [];
      // Ogni fermata appartiene a un solo nodo: scelta deterministica.
      const nodoId = nodi.map(Number).filter(validId).sort((a,b) => a-b)[0];
      if (!nodoId) return null;
      return { nodo_territoriale_id: nodoId, nome: c.nome, indirizzo: c.indirizzo ?? null,
        lat: Number(c.lat), lon: Number(c.lon), osm_id: c.place_id,
        riferimento_fonte: c.riferimento_fonte };
    }).filter(Boolean);
  return { comune: CITIES[istat], istat, limite, censite, residue, selezionati, errori };
}

async function saveCandidate(c) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock sul budget comunale, come nel servizio di budget PIXEL.
    const { rows: nodeRows } = await client.query(`
      SELECT codice_istat_comune FROM public.nodi_territoriali
      WHERE id=$1 AND attivo=TRUE`, [c.nodo_territoriale_id]);
    if (!nodeRows.length) throw new Error('Nodo non attivo');
    const istat = nodeRows[0].codice_istat_comune;
    const { rows: budgetRows } = await client.query(`
      SELECT COALESCE(max_fermate_override,max_fermate_auto) AS limite
      FROM public.pixel_budget_comunali WHERE codice_istat_comune=$1 FOR UPDATE`, [istat]);
    if (!budgetRows.length) throw new Error('Budget non configurato');
    const { rows: existingByOsm } = await client.query(`
      SELECT fermata_id FROM public.pixel_fermate_test_metadata WHERE osm_id=$1`, [c.osm_id]);
    if (existingByOsm.length) {
      await client.query('COMMIT');
      return { stato: 'gia_acquisita', id: existingByOsm[0].fermata_id };
    }
    const { rows: counts } = await client.query(`
      SELECT COUNT(*)::int AS totale FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
      WHERE n.codice_istat_comune=$1`, [istat]);
    if (Number(counts[0].totale) >= Number(budgetRows[0].limite)) {
      await client.query('COMMIT'); return { stato: 'budget_esaurito' };
    }
    const { rows: duplicate } = await client.query(`
      SELECT f.id FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
      WHERE n.codice_istat_comune=$1 AND ST_DWithin(f.posizione,
        ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,30)
      ORDER BY f.id LIMIT 1`, [istat,c.lon,c.lat]);
    if (duplicate.length) {
      await client.query('COMMIT');
      return { stato: 'duplicata_30m', id: duplicate[0].id };
    }
    const { rows: inserted } = await client.query(`
      INSERT INTO public.pixel_fermate
      (nodo_territoriale_id,nome,indirizzo,posizione,tipi_veicolo_ammessi,verificata,attiva)
      VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
        ARRAY[]::text[],FALSE,FALSE) RETURNING id`,
      [c.nodo_territoriale_id,c.nome,c.indirizzo,c.lon,c.lat]);
    const id = inserted[0].id;
    await client.query(`
      INSERT INTO public.pixel_fermate_test_metadata
      (fermata_id,fonte,riferimento_fonte,osm_id)
      VALUES ($1,'osm',$2,$3)`, [id,c.riferimento_fonte,c.osm_id]);
    await client.query('COMMIT');
    return { stato: 'inserita', id };
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}

export async function acquirePixelTestComune(istat, { write = false } = {}) {
  const plan = await discoverComune(istat);
  if (!write) return { ...plan, modalita: 'ANTEPRIMA', risultati: [] };
  const risultati = [];
  for (const c of plan.selezionati) risultati.push({ osm_id: c.osm_id, ...await saveCandidate(c) });
  return { ...plan, modalita: 'SCRITTURA', risultati };
}
