// services/search/popbus-fermate-alternative.service.js
// Fase 1: candidati di salita/discesa per richieste POPBUS in formazione.
// READ ONLY: non scrive nel DB, non modifica PIXEL/POPBUS V2, non abilita il booking.
import { getDurataDistanza } from '../../utils/maps.util.js';

const idValido = value => {
  const str = String(value ?? '');
  return /^[1-9]\d*$/.test(str) && BigInt(str) <= BigInt(Number.MAX_SAFE_INTEGER) ? str : null;
};
const coordValide = p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) &&
  Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180 &&
  !(Number(p.lat) === 0 && Number(p.lon) === 0);
const metricheValide = v => v && Number.isFinite(Number(v.distanzaKm)) &&
  Number.isFinite(Number(v.durataMs)) && Number(v.distanzaKm) >= 0 && Number(v.durataMs) >= 0;

/**
 * Genera coppie stradalmente compatibili con una ricerca, NON missioni prenotabili.
 * Il nodo di origine/destinazione proviene solo dal contesto PIXEL server-side.
 * @param {object} params
 * @param {object} params.pool - pool/client pg (solo SELECT)
 * @param {object} params.origine - coordinate ricerca {lat, lon}
 * @param {object} params.destinazione - coordinate ricerca {lat, lon}
 * @param {string|number} params.origineNodoId - nodo PIXEL autorevole
 * @param {string|number} params.destinazioneNodoId - nodo PIXEL autorevole
 * @param {string|Date} params.startDatetime - partenza richiesta
 * @param {function} [params.route] - provider stradale iniettabile per test
 * @param {number} [params.maxAccessoMinuti=12]
 * @param {number} params.maxDeviazionePct - obbligatorio: ricavare dalla classe PIXEL/POPBUS
 * @param {number} [params.maxFermatePerNodo=8]
 * @param {number} [params.maxCoppie=20]
 */
export async function generaCoppieFermatePopbus({
  pool, origine, destinazione, origineNodoId, destinazioneNodoId, startDatetime,
  route = getDurataDistanza, maxAccessoMinuti = 12, maxDeviazionePct,
  maxFermatePerNodo = 8, maxCoppie = 20, fermateCatalogoIds = null, soloVerificate = false
}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Pool PostgreSQL obbligatorio');
  const nodoOrigine = idValido(origineNodoId);
  const nodoDestinazione = idValido(destinazioneNodoId);
  if (!nodoOrigine || !nodoDestinazione || nodoOrigine === nodoDestinazione) {
    throw new Error('Nodi territoriali PIXEL non validi');
  }
  if (!coordValide(origine) || !coordValide(destinazione)) throw new Error('Coordinate ricerca non valide');
  const partenza = new Date(startDatetime).getTime();
  if (!Number.isFinite(partenza) || partenza <= Date.now()) throw new Error('Data partenza futura obbligatoria');
  if (![maxAccessoMinuti, maxDeviazionePct, maxFermatePerNodo, maxCoppie].every(Number.isFinite) ||
      maxAccessoMinuti < 0 || maxAccessoMinuti > 120 || maxDeviazionePct < 0 || maxDeviazionePct > 100 ||
      !Number.isInteger(maxFermatePerNodo) || maxFermatePerNodo < 1 || maxFermatePerNodo > 30 ||
      !Number.isInteger(maxCoppie) || maxCoppie < 1 || maxCoppie > 100) {
    throw new Error('Limiti alternative non validi');
  }

  // Gli stessi filtri di sicurezza presenti nella validazione PIXEL.
  // Non usare tipi_veicolo_ammessi come filtro escludente.
  const { rows } = await pool.query(`
    SELECT f.id AS fermata_id, f.nodo_territoriale_id, f.nome,
           ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon,
           f.google_place_id, f.google_geo_scade_il
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id AND n.attivo = TRUE
    WHERE f.nodo_territoriale_id = ANY($1::bigint[]) AND f.attiva = TRUE
      AND ($8::bigint[] IS NULL OR f.id = ANY($8::bigint[]))
      AND (NOT $9::boolean OR f.verificata IS TRUE)
      AND upper(ltrim(f.nome)) NOT LIKE 'TEST PIXEL%'
      AND upper(ltrim(f.nome)) NOT LIKE '[TEST PIXEL]%'
      AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_fonti ff
                      WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa')
      AND (f.google_place_id IS NULL OR
           f.google_geo_scade_il > GREATEST(NOW(), $2::timestamptz + INTERVAL '12 hours'))
    ORDER BY f.nodo_territoriale_id,
      ST_Distance(f.posizione::geography,
        CASE WHEN f.nodo_territoriale_id = $3::bigint
          THEN ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography
          ELSE ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography END),
      f.id
  `, [[nodoOrigine, nodoDestinazione], new Date(partenza).toISOString(),
      nodoOrigine, Number(origine.lon), Number(origine.lat), Number(destinazione.lon), Number(destinazione.lat),
      fermateCatalogoIds == null ? null : fermateCatalogoIds.map(idValido).filter(Boolean), soloVerificate === true]);

  const origineFermate = rows.filter(r => String(r.nodo_territoriale_id) === nodoOrigine && coordValide(r))
    .slice(0, maxFermatePerNodo);
  const destinazioneFermate = rows.filter(r => String(r.nodo_territoriale_id) === nodoDestinazione && coordValide(r))
    .slice(0, maxFermatePerNodo);
  if (!origineFermate.length || !destinazioneFermate.length) return { coppie: [], totale: 0, stato: 'nessuna_fermata' };

  // Cache locale: nessun percorso stradale viene calcolato più volte per coppia di punti.
  const cache = new Map();
  async function percorso(a, b) {
    const key = `${a.lat},${a.lon}>${b.lat},${b.lon}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        if (Number(a.lat) === Number(b.lat) && Number(a.lon) === Number(b.lon)) {
          return { distanzaKm: 0, durataMs: 0 };
        }
        try {
          const r = await route(a, b);
          return metricheValide(r) ? { distanzaKm: Number(r.distanzaKm), durataMs: Number(r.durataMs) } : null;
        } catch { return null; }
      })());
    }
    return cache.get(key);
  }
  const diretta = await percorso(origine, destinazione);
  if (!diretta || diretta.distanzaKm <= 0 || diretta.durataMs <= 0) {
    return { coppie: [], totale: 0, stato: 'percorso_non_disponibile' };
  }

  const coppie = [];
  for (const salita of origineFermate) {
    const accesso = await percorso(origine, salita);
    if (!accesso || accesso.durataMs > maxAccessoMinuti * 60000) continue;
    for (const discesa of destinazioneFermate) {
      if (String(salita.fermata_id) === String(discesa.fermata_id)) continue;
      const uscita = await percorso(discesa, destinazione);
      if (!uscita || uscita.durataMs > maxAccessoMinuti * 60000) continue;
      const tratta = await percorso(salita, discesa);
      if (!tratta || tratta.distanzaKm <= 0 || tratta.durataMs <= 0) continue;
      const distanzaTotaleKm = accesso.distanzaKm + tratta.distanzaKm + uscita.distanzaKm;
      const durataTotaleMinuti = (accesso.durataMs + tratta.durataMs + uscita.durataMs) / 60000;
      if (distanzaTotaleKm > diretta.distanzaKm * (1 + maxDeviazionePct / 100)) continue;
      coppie.push({
        origine_fermata_id: String(salita.fermata_id),
        destinazione_fermata_id: String(discesa.fermata_id),
        salita: { fermata_id: String(salita.fermata_id), nodo_territoriale_id: nodoOrigine,
                  nome: salita.nome, lat: Number(salita.lat), lon: Number(salita.lon),
                  provvisoria: salita.google_place_id != null },
        discesa: { fermata_id: String(discesa.fermata_id), nodo_territoriale_id: nodoDestinazione,
                   nome: discesa.nome, lat: Number(discesa.lat), lon: Number(discesa.lon),
                   provvisoria: discesa.google_place_id != null },
        accesso_salita_minuti: Math.ceil(accesso.durataMs / 60000),
        accesso_discesa_minuti: Math.ceil(uscita.durataMs / 60000),
        distanza_totale_km: Math.round(distanzaTotaleKm * 100) / 100,
        durata_totale_minuti: Math.ceil(durataTotaleMinuti),
        distanza_tratta_km: Math.round(tratta.distanzaKm * 100) / 100,
        durata_tratta_minuti: tratta.durataMs / 60000,
        stato: 'candidata_stradale', prenotabile: false
      });
    }
  }
  coppie.sort((a, b) => a.durata_totale_minuti - b.durata_totale_minuti ||
    a.distanza_totale_km - b.distanza_totale_km ||
    a.origine_fermata_id.localeCompare(b.origine_fermata_id) ||
    a.destinazione_fermata_id.localeCompare(b.destinazione_fermata_id));
  return { coppie: coppie.slice(0, maxCoppie), totale: coppie.length, stato: 'candidate_stradali',
    prenotazione_abilitata: false };
}