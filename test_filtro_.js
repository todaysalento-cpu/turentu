/**
 * TEST SUITE: Motore di Ricerca Segmentato
 * Verifica la logica di sovrapposizione tratte e calcolo posti liberi.
 */

// 1. Funzione logica estratta dal tuo engine per il test
function calcolaDisponibilita(richiesta, corsa, prenotazioni) {
    const { idxStart, idxEnd } = richiesta;
    
    const occupazioneSegmento = prenotazioni.reduce((max, p) => {
        // Logica di sovrapposizione
        const sovrappone = (Number(idxStart) < Number(p.end_index_polyline)) && 
                           (Number(idxEnd) > Number(p.start_index_polyline));
        
        return sovrappone ? max + Number(p.posti_richiesti || 0) : max;
    }, 0);

    return Number(corsa.posti_totali) - occupazioneSegmento;
}

// 2. Esecuzione Test
function runTests() {
    console.log("🧪 Inizio test filtraggio tratte intermedie...\n");

    const corsa = { id: 101, posti_totali: 4 };

    const testCases = [
        {
            nome: "Tratta intermedia libera",
            req: { idxStart: 20, idxEnd: 40 },
            prenotazioni: [
                { start_index_polyline: 60, end_index_polyline: 80, posti_richiesti: 1 }
            ],
            atteso: 4
        },
        {
            nome: "Tratta intermedia occupata",
            req: { idxStart: 20, idxEnd: 40 },
            prenotazioni: [
                { start_index_polyline: 10, end_index_polyline: 30, posti_richiesti: 2 } // Sovrappone 20-30
            ],
            atteso: 2
        },
        {
            nome: "Tratta intermedia totalmente piena",
            req: { idxStart: 20, idxEnd: 40 },
            prenotazioni: [
                { start_index_polyline: 10, end_index_polyline: 50, posti_richiesti: 4 }
            ],
            atteso: 0
        }
    ];

    testCases.forEach(t => {
        const postiLiberi = calcolaDisponibilita(t.req, corsa, t.prenotazioni);
        const pass = postiLiberi === t.atteso;
        console.log(`${pass ? "✅" : "❌"} Test: ${t.nome}`);
        console.log(`   -> Atteso: ${t.atteso} | Calcolato: ${postiLiberi}`);
    });
}

runTests();