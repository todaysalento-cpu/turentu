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
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 150; 
    let stats = { d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords || c.decodedCoords.length < 2) continue;

        const coords = c.decodedCoords; 
        const route = turf.lineString(coords);

        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) { 
            stats.d++; continue; 
        }

        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        const idxDiff = endPointOnLine.properties.index - startPointOnLine.properties.index;
        
        // LOG DI DEBUG: fondamentale per capire se la polyline è troppo corta o invertita
        console.log(`[DEBUG-DIR] Corsa ${c.id}: idxDiff=${idxDiff.toFixed(2)} (StartIdx: ${startPointOnLine.properties.index.toFixed(0)}, EndIdx: ${endPointOnLine.properties.index.toFixed(0)})`);

        // Accettiamo sia corse dirette che inverse usando Math.abs
        if (Math.abs(idxDiff) < 0.1) { 
            stats.dir++; continue; 
        }

        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        const occupazione = prenotazioni.reduce((acc, p) => acc + (Number(p?.posti_richiesti) || 0), 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

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
        // Controllo disponibilità reale e posti
        const postiTotali = Number(s.posti_totali || 0);
        const postiPrenotati = Number(s.posti_prenotati || 0);
        if (s.disponibile !== true || (postiTotali - postiPrenotati) < postiRichiesti) return false;

        const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
        if (!veicolo || !veicolo.lat || !veicolo.lon) return false;

        const vPos = turf.point([veicolo.lon, veicolo.lat]);
        return turf.distance(pStart, vPos, { units: 'kilometers' }) <= MAX_DIST_KM;
    });

    console.log(`[FILTER-SLOT] ${slotsValidi.length}/${allSlots.length} ok | (${Date.now() - startTime}ms)`);
    return slotsValidi.map(s => ({ id: `slot_ind_${s.id}`, veicolo_id: s.veicolo_id, posti_disponibili: s.posti_totali - (s.posti_prenotati || 0), prezzo: 0, start_datetime: s.start_datetime }));
}