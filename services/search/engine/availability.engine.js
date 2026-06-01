import * as turf from '@turf/turf';
import { CacheStore } from '../search.cache.js';
import params from '../../../config/params.js';

/**
 * MOTORE 1: FILTRO CORSE (Geometrico)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    // Turf lavora in [lon, lat] - Richiesta corretta
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 150; 
    let stats = { d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        
        if (!c?.decodedCoords || c.decodedCoords.length < 2) continue;

        // DIAGNOSTICA: Stampiamo il primo punto per vedere com'è fatto
        // Se vedi [18.3, 39.8], è [lon, lat]. Se vedi [39.8, 18.3], è [lat, lon].
        // Se è già [lon, lat], NON invertire.
        const coords = c.decodedCoords; 
        const route = turf.lineString(coords);

        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) { 
            console.log(`[LOG-FILTER] Corsa ${c.id} SCARTATA (Distanza): Start=${distStart.toFixed(1)}km, End=${distEnd.toFixed(1)}km. Dati: ${JSON.stringify(coords[0])}`);
            stats.d++; continue; 
        }

        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        const idxDiff = endPointOnLine.properties.index - startPointOnLine.properties.index;
        
        if (idxDiff < 0.1) { 
            stats.dir++; continue; 
        }

        const postiLiberi = Number(c.posti_totali || 0) - (Array.isArray(prenotazioniData[i]) ? prenotazioniData[i].reduce((a, p) => a + Number(p?.posti_richiesti || 0), 0) : 0);

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else { stats.p++; }
    }

    console.log(`[FILTER-CORSE] ${corseValide.length} ok | Scarti: D=${stats.d} Dir=${stats.dir} P=${stats.p} (${Date.now() - startTime}ms)`);
    return { slots: corseValide.map(c => ({ id: `slot_${c.id}`, corsa_id: c.id, veicolo_id: c.veicolo_id, posti_disponibili: c.postiDisponibili, prezzo: c.prezzo_fisso, start_datetime: c.start_datetime })), corse: corseValide };
}

/**
 * MOTORE 2: FILTRO SLOT
 */
export async function filterSlotOnly(richiesta, allSlots) {
    const startTime = Date.now();
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const MAX_DIST_KM = 100;
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    
    const slotsValidi = allSlots.filter(s => {
        const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
        if (!veicolo || !veicolo.lat || !veicolo.lon) return false;

        // Se veicolo.lon/lat sono già corretti, Turf funzionerà
        const vPos = turf.point([veicolo.lon, veicolo.lat]);
        const distanzaKm = turf.distance(pStart, vPos, { units: 'kilometers' });

        return distanzaKm <= MAX_DIST_KM;
    });

    console.log(`[FILTER-SLOT] ${slotsValidi.length}/${allSlots.length} ok | (${Date.now() - startTime}ms)`);
    return slotsValidi.map(s => ({ id: `slot_ind_${s.id}`, veicolo_id: s.veicolo_id, posti_disponibili: s.posti_totali, prezzo: 0, start_datetime: s.start_datetime }));
}