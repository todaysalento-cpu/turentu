import { calcolaPrezzo } from './utils/pricing.util.js';
import { pool } from './db/db.js';

async function runPricingTest() {
    console.log("--- TEST DINAMICO: PREZZO CONDIVISO ---");

    const VEICOLO_ID = 12; 
    const CORSA_ID = 999;
    const mockCorsa = { id: CORSA_ID, veicolo_id: VEICOLO_ID, distanza: 100 };

    try {
        await pool.query('DELETE FROM prenotazioni WHERE corsa_id = $1', [CORSA_ID]);
        await pool.query('DELETE FROM corse WHERE id = $1', [CORSA_ID]);

        await pool.query(
            `INSERT INTO corse (id, veicolo_id, distanza, stato, start_datetime, posti_totali, tipo_corsa) 
             VALUES ($1, $2, $3, $4, NOW(), $5, $6)`,
            [CORSA_ID, VEICOLO_ID, 100, 'prenotabile', 3, 'condivisa']
        );

        const { rows: utenti } = await pool.query('SELECT id FROM utente LIMIT 1');
        const CLIENTE_ID = utenti.length > 0 ? utenti[0].id : 1;

        // 1. Utente 1
        const prezzoU1 = await calcolaPrezzo(mockCorsa, 1, 'prenotabile', 100, 100);
        await pool.query(
            `INSERT INTO prenotazioni (corsa_id, posti_richiesti, posti_prenotati, cliente_id, prezzo_totale) 
             VALUES ($1, $2, $3, $4, $5)`,
            [CORSA_ID, 1, 1, CLIENTE_ID, prezzoU1]
        );

        // 2. Utente 2
        const prezzoU2 = await calcolaPrezzo(mockCorsa, 1, 'prenotabile', 50, 100);
        await pool.query(
            `INSERT INTO prenotazioni (corsa_id, posti_richiesti, posti_prenotati, cliente_id, prezzo_totale) 
             VALUES ($1, $2, $3, $4, $5)`,
            [CORSA_ID, 1, 1, CLIENTE_ID + 1, prezzoU2] // cliente diverso
        );

        // 5. Report Dettagliato
        console.log("\n--- RIEPILOGO CORSA DAL DATABASE ---");
        const { rows: dettagli } = await pool.query(
            `SELECT p.cliente_id, p.prezzo_totale, 100 as km_percorsi 
             FROM prenotazioni p WHERE p.corsa_id = $1`, [CORSA_ID]
        );
        
        console.table(dettagli);
        
        const totCorsa = dettagli.reduce((acc, curr) => acc + parseFloat(curr.prezzo_totale), 0);
        console.log(`Totale incassato dalla corsa: €${totCorsa.toFixed(2)}`);

        if (prezzoU2 < prezzoU1) {
            console.log("✅ TEST PASSATO: Il prezzo dinamico è più equo.");
        }

    } catch (err) {
        console.error("❌ ERRORE:", err);
    } finally {
        await pool.query('DELETE FROM prenotazioni WHERE corsa_id = $1', [CORSA_ID]);
        await pool.query('DELETE FROM corse WHERE id = $1', [CORSA_ID]);
        process.exit();
    }
}

runPricingTest();