/**
 * TURENTU — inizializzazione diagnostica delle tratte NCC condivise.
 * Collocare in tests/init_corse_tratte.js.
 *
 * node tests/init_corse_tratte.js                 -> sola lettura DB, nessuna API Google
 * node tests/init_corse_tratte.js --preview-routing -> Google Directions, nessuna scrittura
 * node tests/init_corse_tratte.js --apply         -> Google Directions e INSERT transazionale
 *
 * Limiti: NON attiva il ritorno nella ricerca, NON migra prenotazioni/pending,
 * NON modifica corse.arrivo_datetime né il prezzo, NON calcola riposi legali.
 */
import { pool } from '../db/db.js';
import { getRouteGeometry } from '../utils/maps.util.js';

const IDS = [866, 899];
const apply = process.argv.includes('--apply');
const previewRouting = process.argv.includes('--preview-routing');
const unknown = process.argv.slice(2).filter(x => !['--apply', '--preview-routing'].includes(x));
if (unknown.length || (apply && previewRouting)) {
  console.error('Uso: node tests/init_corse_tratte.js [--preview-routing | --apply]');
  process.exit(2);
}

function validateRoute(route, label) {
  if (!route?.polyline || typeof route.polyline !== 'string' ||
      !Number.isFinite(Number(route.distanzaKm)) || Number(route.distanzaKm) <= 0 ||
      !Number.isSafeInteger(Number(route.durata)) || Number(route.durata) <= 0) {
    throw new Error(`Routing non valido per ${label}`);
  }
}

function coordinate(row, prefix) {
  const lat = Number(row[`${prefix}_lat`]);
  const lon = Number(row[`${prefix}_lon`]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error(`Coordinate ${prefix} non valide`);
  }
  return { lat, lon };
}

async function loadCorsa(id) {
  const { rows } = await pool.query(`
    SELECT c.id, c.tipo_corsa, c.origine_address, c.destinazione_address,
           c.start_datetime, c.percorso_polyline,
           ST_Y(c.origine::geometry) AS origine_lat,
           ST_X(c.origine::geometry) AS origine_lon,
           ST_Y(c.destinazione::geometry) AS destinazione_lat,
           ST_X(c.destinazione::geometry) AS destinazione_lon,
           (SELECT COUNT(*)::integer FROM public.corse_tratte t WHERE t.corsa_id = c.id) AS tratte_esistenti
    FROM public.corse c WHERE c.id = $1
  `, [id]);
  if (!rows.length) throw new Error(`Corsa ${id} inesistente`);
  return rows[0];
}

async function insertAtomic(corsa, andata, ritorno) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializza gli inserimenti concorrenti per la stessa corsa.
    const locked = await client.query(
      'SELECT id, tipo_corsa FROM public.corse WHERE id = $1 FOR UPDATE', [corsa.id]
    );
    if (locked.rows[0]?.tipo_corsa !== 'condivisa') {
      throw new Error('Corsa non piu condivisa o inesistente');
    }
    const existing = await client.query(
      'SELECT direzione FROM public.corse_tratte WHERE corsa_id = $1', [corsa.id]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      console.log(`⏭️ Corsa ${corsa.id}: gia presenti ${existing.rows.length} tratte; nessuna modifica`);
      return;
    }
    const arrivoAndata = new Date(new Date(corsa.start_datetime).getTime() + Number(andata.durata) * 1000);
    if (!Number.isFinite(arrivoAndata.getTime())) throw new Error('Data di arrivo non valida');
    await client.query(`
      INSERT INTO public.corse_tratte
        (corsa_id, direzione, percorso_polyline, distanza_km, durata_secondi,
         partenza_prevista, arrivo_previsto, stato_temporale)
      VALUES ($1, 'andata', $2, $3, $4, $5, $6, 'programmato')
    `, [corsa.id, corsa.percorso_polyline, andata.distanzaKm, andata.durata,
        corsa.start_datetime, arrivoAndata]);
    await client.query(`
      INSERT INTO public.corse_tratte
        (corsa_id, direzione, percorso_polyline, distanza_km, durata_secondi,
         partenza_prevista, arrivo_previsto, stato_temporale)
      VALUES ($1, 'ritorno', $2, $3, $4, NULL, NULL, 'flessibile')
    `, [corsa.id, ritorno.polyline, ritorno.distanzaKm, ritorno.durata]);
    await client.query('COMMIT');
    console.log(`✅ Corsa ${corsa.id}: entrambe le tratte inserite; ritorno NON prenotabile`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  if ((apply || previewRouting) && !process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY mancante nell’ambiente');
  }
  console.log(`TURENTU — modalita: ${apply ? 'APPLY' : previewRouting ? 'PREVIEW ROUTING' : 'LETTURA DB'}`);
  let errors = 0;
  for (const id of IDS) {
    try {
      const c = await loadCorsa(id);
      if (c.tipo_corsa !== 'condivisa') throw new Error('Tipo corsa non condivisa');
      if (!c.percorso_polyline) throw new Error('Polyline andata assente');
      console.log(`\nCorsa ${id}: ${c.origine_address} -> ${c.destinazione_address}; tratte esistenti=${c.tratte_esistenti}`);
      if (c.tratte_esistenti > 0) {
        console.log('⏭️ Saltata per evitare sovrascritture');
        continue;
      }
      const origine = coordinate(c, 'origine');
      const destinazione = coordinate(c, 'destinazione');
      console.log('Coordinate:', origine, destinazione);
      if (!apply && !previewRouting) continue;
      // Due richieste distinte: il ritorno stradale non si ricava invertendo la polyline.
      const andata = await getRouteGeometry(origine, destinazione);
      validateRoute(andata, 'andata');
      const ritorno = await getRouteGeometry(destinazione, origine);
      validateRoute(ritorno, 'ritorno');
      console.log(`Andata: ${andata.distanzaKm.toFixed(2)} km, ${(andata.durata / 3600).toFixed(2)} ore`);
      console.log(`Ritorno: ${ritorno.distanzaKm.toFixed(2)} km, ${(ritorno.durata / 3600).toFixed(2)} ore`);
      console.log('Arrivo teorico andata:', new Date(new Date(c.start_datetime).getTime() + andata.durata * 1000).toISOString());
      console.log('Nota: la polyline andata esistente viene conservata; la durata proviene dal nuovo routing.');
      if (apply) await insertAtomic(c, andata, ritorno);
      else console.log('🔎 Preview completata: nessuna scrittura');
    } catch (err) {
      errors++;
      console.error(`❌ Corsa ${id}: ${err.message}`);
    }
  }
  if (errors) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error('❌ Errore generale:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
