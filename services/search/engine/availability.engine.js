import * as turf from '@turf/turf';

/**
 * MOTORE DI FILTRAGGIO OTTIMIZZATO
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
        // Se la tratta è molto lunga, 50km è ok, ma verifica se il percorso ha abbastanza punti
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
        // Assicuriamo che prenotazioniData[i] sia un array pulito
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

    console.log(`[FILTER] Elaborati ${stats.totali} in ${Date.now() - startTime}ms | Esito: ${corseValide.length} ok | Scarti (D:${stats.d} Dir:${stats.dir} P:${stats.p})`);
    
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