// Simulazione dati che causano il fallimento
const mockCorsa = {
    id: 101,
    veicolo_id: 1,
    posti_totali: 0, // <--- QUI È IL PROBLEMA CHE RILEVI
    decodedCoords: [[17.9, 40.6], [14.2, 42.4]]
};

const mockSlot = {
    id: 999,
    veicolo_id: 1,
    posti_totali: 0, // <--- SIMULAZIONE DATO MANCANTE
    disponibile: true
};

const mockRichiesta = {
    posti_richiesti: 1,
    coord: { lat: 40.6, lon: 17.9 },
    coordDest: { lat: 42.4, lon: 14.2 }
};

// --- LOGICA DI TEST ---
function testFiltroSlot() {
    console.log("--- TEST FILTRO SLOT ---");
    const allSlots = [mockSlot];
    const postiRichiesti = 1;

    const slotsValidi = allSlots.filter(s => {
        const postiOk = Number(s.posti_totali || 0) >= postiRichiesti;
        console.log(`DEBUG: SlotID ${s.id} | Posti: ${s.posti_totali} | Richiesti: ${postiRichiesti} | Esito: ${postiOk}`);
        return postiOk;
    });

    console.log(`Risultato: ${slotsValidi.length} validi.`);
}

testFiltroSlot();