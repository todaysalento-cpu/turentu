import ngeohash from 'ngeohash';
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { GeoIndex } from './services/search/search.cache.js';

console.log("--- TEST AVANZATI MOTORE RICERCA ---");

const mockDecodedCoords = [[41.90, 12.49], [43.76, 11.25], [45.46, 9.19]];
const corsaBase = {
    id: 'corsa-test-1',
    decodedCoords: mockDecodedCoords,
    posti_totali: 4,
    picco_occupazione: 0,
    bbox: { minLat: 41, maxLat: 46, minLon: 9, maxLon: 13 }
};

// Funzione aggiornata: Popola sia origine che destinazione per permettere l'intersezione
function prepareTest(corsa, richiesta) {
    GeoIndex.clear();
    const hashOrigine = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, 4);
    const hashDest = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, 4);
    
    GeoIndex.set(hashOrigine, new Set([corsa.id]));
    GeoIndex.set(hashDest, new Set([corsa.id]));
    
    console.log(`[SETUP] GeoIndex popolato: Origine(${hashOrigine}), Dest(${hashDest})`);
}

function testPostiEsauriti() {
    const richiesta = { coord: { lat: 41.90, lon: 12.49 }, coordDest: { lat: 43.76, lon: 11.25 }, posti_richiesti: 5 };
    prepareTest(corsaBase, richiesta);
    const { corse } = filterDisponibilita(richiesta, [], [], [{ ...corsaBase, picco_occupazione: 0, posti_totali: 4 }]);
    console.log(corse.length === 0 ? "✅ Test Posti Esauriti: PASSATO" : "❌ Test Posti Esauriti: FALLITO");
}

function testFuoriTolleranza() {
    const richiesta = { coord: { lat: 38.00, lon: 10.00 }, coordDest: { lat: 38.05, lon: 10.05 }, posti_richiesti: 1 };
    prepareTest(corsaBase, richiesta);
    const { corse } = filterDisponibilita(richiesta, [], [], [corsaBase]);
    console.log(corse.length === 0 ? "✅ Test Distanza Eccessiva: PASSATO" : "❌ Test Distanza Eccessiva: FALLITO");
}

function testValidazioneBBox() {
    const richiesta = { coord: { lat: 42.00, lon: 12.00 }, coordDest: { lat: 44.00, lon: 11.00 }, posti_richiesti: 1 };
    prepareTest(corsaBase, richiesta);
    
    console.log("--- DEBUG BBOX ---");
    const { corse } = filterDisponibilita(richiesta, [], [], [corsaBase]);
    
    if (corse.length > 0) {
        console.log("✅ Test BBox: PASSATO");
    } else {
        console.log("❌ Test BBox: FALLITO");
        console.log("Il motore ha filtrato la corsa. Verifica se l'intersezione dei set nel GeoIndex è avvenuta.");
    }
}

process.env.NODE_ENV = 'test';

testPostiEsauriti();
testFuoriTolleranza();
testValidazioneBBox();