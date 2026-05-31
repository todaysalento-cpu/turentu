import * as turf from '@turf/turf';

/**
 * MOTORE 1: FILTRO CORSE (Geometrico)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);

    let stats = { d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords || c.decodedCoords.length < 2) continue;

        const route = turf.lineString(c.decodedCoords);
        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        if (distStart > 50 || distEnd > 50) { stats.d++; continue; }

        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) { stats.dir++; continue; }

        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        const occupazione = prenotazioni.reduce((acc, p) => {
            const data = typeof p === 'string' ? JSON.parse(p) : p;
            return acc + (Number(data?.posti_richiesti) || 0);
        }, 0);
        
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else { stats.p++; }
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
 * MOTORE 2: FILTRO SLOT (Disponibilità oraria)
 */
export async function filterSlotOnly(richiesta, allSlots) {
    const startTime = Date.now();
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    // Debug rapido per capire perché non accetta nulla
    const campioni = allSlots.slice(0, 3).map(s => `Disp:${s.disponibile}, Posti:${s.posti_totali}`);
    
    const slotsValidi = allSlots.filter(s => {
        const disponibile = s.disponibile === true;
        const postiOk = Number(s.posti_totali || 0) >= postiRichiesti;
        return disponibile && postiOk;
    });

    console.log(`[FILTER-SLOT] ${slotsValidi.length}/${allSlots.length} ok | Campioni: [${campioni.join(' | ')}] (${Date.now() - startTime}ms)`);
    
    return slotsValidi.map(s => ({
        id: `slot_ind_${s.id}`,
        veicolo_id: s.veicolo_id,
        is_slot: true,
        posti_disponibili: s.posti_totali,
        prezzo: 0,
        start_datetime: s.start
    }));
}