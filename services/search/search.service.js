import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

// Helpers (getSnapResult, getVirtualSnap, getOccupazioneDinamica) rimangono invariati...

export async function cercaSlotUltra(richiesta) {
    await loadCachesUltra();

    const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
    const destLat = Number(richiesta.coordDest?.lat);
    const destLon = Number(richiesta.coordDest?.lon);
    const pStart = turf.point([lon, lat]);
    const pEnd = turf.point([destLon, destLat]);
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const orarioRichiesto = new Date(richiesta.start_datetime || new Date());

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distKm = info.distanzaKm || 1;
    const distanzaMetri = distKm * 1000;

    // 1. RICERCA CORSE ESISTENTI (Redis)
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));

    const corseCandidate = [...new Set(corsaResults.flat())]
        .map(id => CacheStore.corseCache.get(Number(id)))
        .filter(Boolean);

    const { corse: corseEsistenti } = await filterDisponibilita({ ...richiesta, posti_richiesti: postiRichiesti }, corseCandidate, []);
    
    const risultatiEsistenti = corseEsistenti.map(c => ({ 
        ...c, 
        tipo: c.tipo || 'condivisa',
        is_pool: false,
        distanza: c.distanza || distanzaMetri,
        prezzo_fisso: Number(c.prezzo_fisso) || 0
    }));

    // 1.2 RICERCA SLOT DISPONIBILI (Cache Locale - "Corse Private al volo")
    const risultatiPrivati = [];
    for (const [veicoloId, disp] of CacheStore.veicoloToDisponibilita) {
        // Verifica basica di prossimità (il veicolo deve essere vicino al punto di partenza)
        const distVeicolo = turf.distance(pStart, turf.point([Number(disp.lon), Number(disp.lat)]), { units: 'kilometers' });
        
        if (disp.is_slot && distVeicolo < 50) { // Tolleranza 50km per vedere l'autista in zona
            risultatiPrivati.push({
                id: `priv_${disp.veicolo_id}`,
                tipo: 'privata',
                veicolo_id: disp.veicolo_id,
                posti_disponibili: 8, // Da integrare con logica occupazione reale se serve
                distanza: distanzaMetri,
                is_pool: false,
                messaggio: "Disponibile per corsa privata"
            });
        }
    }

    // 2. LOGICA POP-BUS (Direttrici attive)
    // ... (Logica direttrici rimane invariata) ...

    // 3. FUSIONE
    const risultatiFinali = [...risultatiEsistenti, ...risultatiPrivati, ...risultatiPool];

    // Nuova proposta sempre presente
    risultatiFinali.push({
        id: 'nuova_proposta',
        tipo: 'pop-bus',
        is_nuova_proposta: true,
        messaggio: "Richiedi attivazione nuova direttrice."
    });

    return await formatResults({ ...richiesta, distanzaMetri }, risultatiFinali);
}