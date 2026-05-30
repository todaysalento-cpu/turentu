import 'dotenv/config'; 
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { CacheStore, loadCachesUltra } from './services/search/search.cache.js';

// Funzione helper robusta che accetta sia oggetti che array [lat, lon]
function getDist(p1, p2) {
    const [lat1, lon1] = Array.isArray(p1) ? p1 : [p1.lat || p1.latitude, p1.lon || p1.lng || p1.longitude];
    const [lat2, lon2] = Array.isArray(p2) ? p2 : [p2.lat || p2.latitude, p2.lon || p2.lng || p2.longitude];
    
    const R = 6371; // Raggio terra in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcolaDistanzaPercorso(punti) {
    if (!punti || punti.length < 2) return 0;
    let distanza = 0;
    for (let i = 0; i < punti.length - 1; i++) {
        distanza += getDist(punti[i], punti[i + 1]);
    }
    return distanza;
}

async function runTest() {
    try {
        console.log("🔄 Avvio sincronizzazione cache dal database...");
        await loadCachesUltra(true); 

        const corseArray = Array.from(CacheStore.corseCache.values());
        console.log(`📦 Totale corse nel sistema: ${corseArray.length}`);

        // Esempio di richiesta di test
        const richiesta = {
            coord: { lat: 41.48, lon: 15.58 }, // Foggia
            coordDest: { lat: 42.46, lon: 14.21 }, // Pescara
            posti_richiesti: 1
        };

        const { corse: corseCompatibili } = filterDisponibilita(richiesta, [], [], corseArray);
        const idCompatibili = new Set(corseCompatibili.map(c => c.id));

        console.log(`\n📊 REPORT DETTAGLIATO CORSE:`);
        
        corseArray.forEach((c) => {
            const isCompatibile = idCompatibili.has(c.id);
            const stato = isCompatibile ? "✅ COMPATIBILE" : "❌ SCARTATA";
            
            console.log(`-----------------------------------------------`);
            console.log(`${stato} | ID: ${c.id} | ${c.localitaOrigine || 'N/D'} -> ${c.localitaDestinazione || 'N/D'}`);
            
            if (isCompatibile) {
                // Recupera il percorso segmentato (formato [lat, lon])
                const punti = c.percorsoVisualizzato || [];
                const distKm = calcolaDistanzaPercorso(punti);
                
                console.log(`    💰 Prezzo Totale Corsa: €${Number(c.prezzo || 0).toFixed(2)}`);
                console.log(`    📏 Distanza segmento calcolato: ${distKm.toFixed(2)} km`);
                console.log(`    👥 Occupazione: ${c.picco_occupazione}/${c.posti_totali} posti`);
            } else {
                const postiSufficienti = (c.posti_totali - c.picco_occupazione) >= richiesta.posti_richiesti;
                console.log(`    ⚠️ Motivo: ${postiSufficienti ? "Geometria/Percorso non compatibile" : "Posti esauriti"}`);
            }
        });

        console.log(`\n🏁 Fine report: ${corseCompatibili.length} compatibili, ${corseArray.length - corseCompatibili.length} scartate.`);

    } catch (error) {
        console.error("❌ Errore critico durante il test:", error);
    }
}

runTest();