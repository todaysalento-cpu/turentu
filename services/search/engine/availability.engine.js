import * as turf from '@turf/turf';
import { CacheStore } from '../search.cache.js';
import params from '../../../config/params.js';

/**
 * MOTORE 1: FILTRO CORSE (Geometrico - analizza percorsi predefiniti)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    // Turf usa [lon, lat]
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);

    let stats = { d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        
        // 1. Validazione base
        if (!c?.decodedCoords || c.decodedCoords.length < 2) {
            console.log(`[DEBUG-FILTER] Corsa ${c.id}: dati percorso mancanti.`);
            continue;
        }

        const route = turf.lineString(c.decodedCoords);
        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        // 2. Controllo Distanza (Tolleranza 50km)
        if (distStart > 50 || distEnd > 50) { 
            console.log(`[DEBUG-FILTER] Corsa ${c.id} scartata: Distanza fuori tolleranza (Start:${distStart.toFixed(1)}km, End:${distEnd.toFixed(1)}km)`);
            stats.d++; continue; 
        }

        // 3. Controllo Direzione
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) { 
            console.log(`[DEBUG-FILTER] Corsa ${c.id} scartata: Direzione errata (S-Idx:${startPointOnLine.properties.index}, E-Idx:${endPointOnLine.properties.index})`);
            stats.dir++; continue; 
        }

        // 4. Controllo Posti
        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        const occupazione = prenotazioni.reduce((acc, p) => {
            const data = typeof p === 'string' ? JSON.parse(p) : p;
            return acc + (Number(data?.posti_richiesti) || 0);
        }, 0);
        
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else { 
            console.log(`[DEBUG-FILTER] Corsa ${c.id} scartata: Posti insufficienti (Liberi:${postiLiberi})`);
            stats.p++; 
        }
    }

    console.log(`[FILTER-CORSE] ${corseValide.length} ok | Scarti: Dist=${stats.d} Dir=${stats.dir} Posti=${stats.p} (${Date.now() - startTime}ms)`);
    
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
 * MOTORE 2: FILTRO SLOT (Disponibilità oraria + Prossimità geografica)
 */
export async function filterSlotOnly(richiesta, allSlots) {
    const startTime = Date.now();
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const MAX_DIST_KM = params.tolleranzaKm || 100;
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    
    const slotsValidi = allSlots.filter(s => {
        // 1. Verifica disponibilità logica
        if (s.disponibile !== true || Number(s.posti_totali || 0) < postiRichiesti) {
            return false;
        }

        // 2. Verifica Prossimità Geografica
        const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
        if (!veicolo || !veicolo.lat || !veicolo.lon) {
            console.log(`[DEBUG-SLOT] Slot ${s.id} scartato: Veicolo ${s.veicolo_id} non trovato o senza coordinate.`);
            return false;
        }

        const vPos = turf.point([veicolo.lon, veicolo.lat]);
        const distanzaKm = turf.distance(pStart, vPos, { units: 'kilometers' });

        if (distanzaKm > MAX_DIST_KM) {
            console.log(`[DEBUG-SLOT] Slot ${s.id} scartato: Distanza eccessiva (${distanzaKm.toFixed(1)}km)`);
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