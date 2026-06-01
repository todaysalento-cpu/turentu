import * as turf from '@turf/turf';
import { CacheStore } from '../search.cache.js';
import params from '../../../config/params.js';

/**
 * MOTORE 1: FILTRO CORSE (Geometrico)
 * Log diagnostici inclusi per monitorare gli scarti
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    // Tolleranza estesa per tratte a lunga percorrenza
    const TOLLERANZA_KM = 150; 

    let stats = { d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        
        if (!c?.decodedCoords || c.decodedCoords.length < 2) {
            console.log(`[LOG-FILTER] Corsa ${c.id}: Dati percorso assenti/invalidi.`);
            continue;
        }

        const coords = c.decodedCoords.map(p => Array.isArray(p) ? [p[1], p[0]] : [p.lon || p.lng, p.lat]);
        const route = turf.lineString(coords);

        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        // 1. Controllo Distanza
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) { 
            console.log(`[LOG-FILTER] Corsa ${c.id} SCARTATA per DISTANZA: StartDist=${distStart.toFixed(1)}km, EndDist=${distEnd.toFixed(1)}km (Limit=${TOLLERANZA_KM})`);
            stats.d++; continue; 
        }

        // 2. Controllo Direzione
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        const idxDiff = endPointOnLine.properties.index - startPointOnLine.properties.index;
        
        if (idxDiff < 0.1) { 
            console.log(`[LOG-FILTER] Corsa ${c.id} SCARTATA per DIREZIONE: DiffIndex=${idxDiff.toFixed(2)}. StartIdx=${startPointOnLine.properties.index.toFixed(0)}, EndIdx=${endPointOnLine.properties.index.toFixed(0)}`);
            stats.dir++; continue; 
        }

        // 3. Controllo Posti
        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        const occupazione = prenotazioni.reduce((acc, p) => acc + (Number(p?.posti_richiesti) || 0), 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else { 
            console.log(`[LOG-FILTER] Corsa ${c.id} SCARTATA per POSTI: Disponibili=${postiLiberi}, Richiesti=${postiRichiesti}`);
            stats.p++; 
        }
    }

    console.log(`[FILTER-CORSE] ${corseValide.length} ok | Scarti: D=${stats.d} Dir=${stats.dir} P=${stats.p} (${Date.now() - startTime}ms)`);
    
    return {
        slots: corseValide.map(c => ({
            id: `slot_${c.id}`,
            corsa_id: c.id,
            veicolo_id: c.veicolo_id,
            is_slot: true,
            posti_disponibili: c.postiDisponibili,
            prezzo: c.prezzo_fisso,
            start_datetime: c.start_datetime
        })),
        corse: corseValide
    };
}

/**
 * MOTORE 2: FILTRO SLOT (Disponibilità oraria + Prossimità)
 */
export async function filterSlotOnly(richiesta, allSlots) {
    const startTime = Date.now();
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const MAX_DIST_KM = params.tolleranzaKm || 500; 
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    
    const slotsValidi = allSlots.filter(s => {
        if (s.disponibile !== true || Number(s.posti_totali || 0) < postiRichiesti) return false;

        const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
        if (!veicolo || !veicolo.lat || !veicolo.lon) return false;

        const vPos = turf.point([veicolo.lon, veicolo.lat]);
        const distanzaKm = turf.distance(pStart, vPos, { units: 'kilometers' });

        if (distanzaKm > MAX_DIST_KM) {
            console.log(`[LOG-SLOT] Slot ${s.id} SCARTATO: Distanza ${distanzaKm.toFixed(0)}km > Max ${MAX_DIST_KM}km`);
            return false;
        }

        return true;
    });

    console.log(`[FILTER-SLOT] ${slotsValidi.length}/${allSlots.length} ok | (${Date.now() - startTime}ms)`);
    
    return slotsValidi.map(s => ({
        id: `slot_ind_${s.id}`,
        veicolo_id: s.veicolo_id,
        is_slot: true,
        posti_disponibili: s.posti_totali,
        prezzo: 0,
        start_datetime: s.start_datetime
    }));
}