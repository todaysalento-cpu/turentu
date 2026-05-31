import * as turf from '@turf/turf';

/**
 * MOTORE 1: FILTRO CORSE (Geometrico + Posti)
 * Verifica rotta (Turf) e occupazione veicolo
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);

    let stats = { totali: corseCandidate.length, d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords || c.decodedCoords.length < 2) continue;

        const route = turf.lineString(c.decodedCoords);
        
        // 1. Verifica geometrica (Distanza in KM)
        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        if (distStart > 50 || distEnd > 50) {
            stats.d++;
            continue;
        }

        // 2. Verifica Direzione
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) {
            stats.dir++;
            continue;
        }

        // 3. Calcolo disponibilità
        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        const occupazione = prenotazioni.reduce((acc, p) => {
            try {
                const data = typeof p === 'string' ? JSON.parse(p) : p;
                return acc + (Number(data?.posti_richiesti) || 0);
            } catch { return acc; }
        }, 0);
        
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else {
            stats.p++;
        }
    }

    console.log(`[FILTER-CORSE] Elaborati ${stats.totali} in ${Date.now() - startTime}ms | Accettate: ${corseValide.length} | Scarti (D:${stats.d} Dir:${stats.dir} P:${stats.p})`);
    
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
 * MOTORE 2: FILTRO SLOT (Solo Disponibilità Oraria)
 * Ignora la geometria (Turf). Verifica solo se il driver è al lavoro e ha posto.
 */
export async function filterSlotOnly(richiesta, allSlots) {
    const startTime = Date.now();
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const slotsValidi = allSlots.filter(s => {
        // 'disponibile' è il flag booleano calcolato nel servizio di disponibilità
        return s.disponibile === true && Number(s.posti_totali || 0) >= postiRichiesti;
    });

    console.log(`[FILTER-SLOT] Elaborati ${allSlots.length} in ${Date.now() - startTime}ms | Accettate: ${slotsValidi.length}`);
    
    return slotsValidi.map(s => ({
        id: `slot_ind_${s.id}`,
        veicolo_id: s.veicolo_id,
        is_slot: true,
        posti_disponibili: s.posti_totali,
        prezzo: 0, // Prezzo da definire in base alla logica di business
        start_datetime: s.start
    }));
}