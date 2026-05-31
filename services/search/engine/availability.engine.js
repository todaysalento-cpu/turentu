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

    // Statistiche per monitoraggio leggero
    let stats = { totali: corseCandidate.length, scartateDist: 0, scartateDir: 0, scartatePosti: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords) continue;

        const route = turf.lineString(c.decodedCoords);
        
        // 1. Verifica geometrica
        const distStart = turf.pointToLineDistance(pStart, route);
        const distEnd = turf.pointToLineDistance(pEnd, route);
        
        if (distStart > 50 || distEnd > 50) {
            stats.scartateDist++;
            continue;
        }

        // 2. Verifica Direzione
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) {
            stats.scartateDir++;
            continue;
        }

        // 3. Calcolo disponibilità
        const occupazione = (prenotazioniData[i] || []).reduce((acc, p) => {
            try { return acc + (JSON.parse(p)?.posti_richiesti || 0); } catch { return acc; }
        }, 0);
        
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else {
            stats.scartatePosti++;
        }
    }

    console.log(`[FILTER] Elaborati ${stats.totali} candidati in ${Date.now() - startTime}ms. Accettate: ${corseValide.length}, Scarti(D: ${stats.scartateDist}, Dir: ${stats.scartateDir}, Posti: ${stats.scartatePosti})`);
    
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