import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import polyline from 'polyline'; 
import { haversineDistance } from '../../../utils/geo.util.js';
import params from '../../../config/params.js';

const GEOHASH_PRECISION = 5;

/**
 * Genera un'area di ricerca espansa per minimizzare i falsi negativi
 */
function getAreaRicercaEspansa(lat, lon) {
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION);
    const vicini = ngeohash.neighbors(hash);
    // Espansione: includiamo anche i vicini dei vicini (copertura ~15-20km)
    const extra = [];
    vicini.forEach(v => extra.push(...ngeohash.neighbors(v)));
    return [...new Set([hash, ...vicini, ...extra])];
}

/**
 * Taglia la polilinea originale
 */
export function getSottoPercorso(polylineString, salita, discesa) {
  try {
    const decoded = polyline.decode(polylineString);
    const line = turf.lineString(decoded.map(c => [c[1], c[0]]));
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    return slice.geometry.coordinates.map(c => [c[1], c[0]]);
  } catch (e) {
    console.error("Errore nel taglio della polilinea:", e);
    return [];
  }
}

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const tolKm = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);
  const dataOggi = new Date();

  // Area di ricerca espansa per ottimizzare la selezione
  const hashVicini = getAreaRicercaEspansa(richiesta.coord.lat, richiesta.coord.lon);

  // 1. FILTRO SLOT
  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache.find(veicolo => veicolo.id === dv.veicolo_id);
      if (!v || Number(v.posti_totali) < postiRichiesti) return false;
      return haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord) <= tolKm;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  // 2. FILTRO CORSE (Logica Ibrida)
  const corse = corseCache.filter(c => {
    if (new Date(c.start_datetime) < dataOggi) return false;

    // A. Posti
    if ((Number(c.picco_occupazione || 0) + postiRichiesti) > Number(c.posti_totali)) return false;

    // B. Pre-filtro Geohash (Ottimizzazione)
    let pathHashes = [];
    if (Array.isArray(c.path_geohashes)) {
        pathHashes = c.path_geohashes;
    } else if (typeof c.path_geohashes === 'string') {
        pathHashes = c.path_geohashes.replace(/[{}]/g, '').split(',').filter(h => h.length > 0);
    }

    // Se la corsa ha hash, verifichiamo il match. 
    // Se NON matchano, usciamo subito per risparmiare calcoli complessi (Performance)
    if (pathHashes.length > 0 && !pathHashes.some(h => hashVicini.includes(h))) {
        return false;
    }

    // C. Controllo Geometrico Preciso (Verità assoluta)
    if (!c.percorso_polyline) return false;
    
    try {
      const decoded = polyline.decode(c.percorso_polyline);
      const line = turf.lineString(decoded.map(coord => [coord[1], coord[0]]));
      const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
      const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
      
      if (turf.pointToLineDistance(salita, line) > tolKm || 
          turf.pointToLineDistance(discesa, line) > tolKm) {
        return false;
      }

      // D. Fermate
      if ((c.numero_prenotazioni_attive || 0) + calcolaNuoveFermate(c, richiesta) > maxStops) {
        return false;
      }

      c.percorsoVisualizzato = getSottoPercorso(c.percorso_polyline, richiesta.coord, richiesta.coordDest);
      return true;

    } catch (err) {
      return false;
    }
  });

  return { slots, corse };
}

// Helper invariati
export function rankResults(corse, recensioniCache) {
  return corse.sort((a, b) => {
    const rA = recensioniCache[a.conducente_id] || { media: 3.0, totale: 0 };
    const rB = recensioniCache[b.conducente_id] || { media: 3.0, totale: 0 };
    return (rB.media) - (rA.media);
  });
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const f = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];  
  if (!f.some(x => turf.distance(turf.point([x.lon, x.lat]), turf.point([richiesta.coord.lon, richiesta.coord.lat])) < 0.5)) extra++;
  if (!f.some(x => turf.distance(turf.point([x.lon, x.lat]), turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat])) < 0.5)) extra++;
  return extra;
}