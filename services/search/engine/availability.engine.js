import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import polyline from 'polyline'; 
import { haversineDistance } from '../../../utils/geo.util.js';
import params from '../../../config/params.js';

const GEOHASH_PRECISION = 5;

/**
 * Taglia la polilinea originale basandosi sui punti di salita/discesa richiesti.
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

/**
 * Motore di ricerca Disponibilità e Ridesharing con Normalizzazione Dati DB
 */
export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const tolKm = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);

  const reqHash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const hashVicini = [...ngeohash.neighbors(reqHash), reqHash];

  // 1. FILTRO SLOT
  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache.find(veicolo => veicolo.id === dv.veicolo_id);
      if (!v || Number(v.posti_totali) < postiRichiesti) return false;
      const distanzaKm = richiesta.coord ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord) : 0;
      return distanzaKm <= tolKm;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  // 2. FILTRO CORSE con normalizzazione geohash
  const corse = corseCache.filter(c => {
    console.log(`🔍 [ENGINE] Analisi Corsa ID: ${c.id}`);

    // A. Posti
    const postiOccupati = Number(c.picco_occupazione || 0);
    if ((postiOccupati + postiRichiesti) > Number(c.posti_totali)) {
        console.log(`   ❌ Scartata: Posti ${postiOccupati + postiRichiesti} > ${c.posti_totali}`);
        return false;
    }

    // B. Normalizzazione e Filtro Geohash
    // Converte il formato Postgres "{a,b}" o array standard in array di stringhe
    let pathHashes = [];
    if (Array.isArray(c.path_geohashes)) {
        pathHashes = c.path_geohashes;
    } else if (typeof c.path_geohashes === 'string') {
        pathHashes = c.path_geohashes.replace(/[{}]/g, '').split(',');
    }

    if (!pathHashes.some(h => hashVicini.includes(h))) {
        console.log(`   ❌ Scartata: Geohash [${pathHashes}] non matchano req: ${reqHash}`);
        return false;
    }

    if (!c.percorso_polyline) return false;
    
    try {
      const decoded = polyline.decode(c.percorso_polyline);
      const line = turf.lineString(decoded.map(coord => [coord[1], coord[0]]));
      const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
      const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
      
      const distSalita = turf.pointToLineDistance(salita, line);
      const distDiscesa = turf.pointToLineDistance(discesa, line);

      // C. Tolleranza Geografica
      if (distSalita > tolKm || distDiscesa > tolKm) {
        console.log(`   ❌ Scartata: Distanza linea (Salita: ${distSalita.toFixed(2)}km, Discesa: ${distDiscesa.toFixed(2)}km) > ${tolKm}km`);
        return false;
      }

      // D. Fermate
      const fermateExtra = calcolaNuoveFermate(c, richiesta);
      if ((c.numero_prenotazioni_attive || 0) + fermateExtra > maxStops) {
        console.log(`   ❌ Scartata: Troppe fermate (${(c.numero_prenotazioni_attive || 0) + fermateExtra})`);
        return false;
      }

      console.log(`   ✅ Corsa ${c.id} COMPATIBILE`);
      c.percorsoVisualizzato = getSottoPercorso(c.percorso_polyline, richiesta.coord, richiesta.coordDest);
      return true;

    } catch (err) {
      console.error(`   💥 [ENGINE ERROR] Corsa ${c.id}:`, err);
      return false;
    }
  });

  return { slots, corse };
}

/**
 * RANKING
 */
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