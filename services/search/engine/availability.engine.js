// engine/availability.engine.js
import ngeohash from 'ngeohash';
import { haversineDistance } from '../../../utils/geo.util.js';
import params from '../../../config/params.js';

const GEOHASH_PRECISION = 5;

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  const richiestaStart = new Date(richiesta.start_datetime);
  const day = richiestaStart.getDay();
  const currentMinutes = richiestaStart.getHours() * 60 + richiestaStart.getMinutes();

  // Geohash origine richiesta
  const richiestaHashOrig = richiesta.coord
    ? ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION)
    : null;
  const hashViciniOrig = richiestaHashOrig
    ? [...ngeohash.neighbors(richiestaHashOrig), richiestaHashOrig]
    : [];

  // Geohash destinazione richiesta
  const richiestaHashDest = richiesta.coordDest
    ? ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION)
    : null;
  const hashViciniDest = richiestaHashDest
    ? [...ngeohash.neighbors(richiestaHashDest), richiestaHashDest]
    : [];

  // =========================
  // FILTRO SLOT (VEICOLI LIBERI)
  // =========================
  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache[dv.veicolo_id];
      if (!v) return false;
      if (v.posti_totali < richiesta.posti_richiesti) return false;
      if (dv.giorni_esclusi?.includes(day)) return false;

      // Controlla se il veicolo è già occupato da una corsa
      const occupato = corseCache.some(c => {
        if (c.veicolo_id !== dv.veicolo_id) return false;
        const cStart = new Date(c.start_datetime).getTime();
        const cEnd   = new Date(c.arrivo_datetime).getTime();
        const reqTime = richiestaStart.getTime();
        return reqTime >= cStart && reqTime <= cEnd;
      });
      if (occupato) return false;

      // Controlla orario turno (solo ore e minuti)
      const startDate = new Date(dv.start);
      const endDate   = new Date(dv.fine);
      const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
      const endMinutes   = endDate.getHours() * 60 + endDate.getMinutes();

      if (currentMinutes < startMinutes || currentMinutes > endMinutes) return false;

      // Distanza origine
      const distanzaKm = richiesta.coord
        ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord)
        : 0;

      if (richiestaHashOrig && !hashViciniOrig.includes(v.geohash) && distanzaKm > params.tolleranzaKm)
        return false;

      dv._distanzaKm = distanzaKm;
      return true;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  // =========================
  // FILTRO CORSE CON GEOHASH
  // =========================
  const corse = corseCache.filter(c => {
    if (richiesta.posti_richiesti > c.posti_disponibili) return false;

    if (richiesta.coord && richiesta.coordDest) {
      const origOk = [c.geohashOrigine, ...ngeohash.neighbors(c.geohashOrigine)].includes(
        ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION)
      );
      const destOk = [c.geohashDest, ...ngeohash.neighbors(c.geohashDest)].includes(
        ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION)
      );
      if (!origOk || !destOk) return false;
    }

    return true;
  });

  return { slots, corse };
}