// services/popbus/automation.service.js
import { pool } from '../../db/db.js';

/**
 * Job principale: Analizza le richieste e crea direttrici virtuali basate sul flusso (OD)
 */
export const monitoraggioSoglie = async () => {
    try {
        // 1. Identifica flussi comuni: raggruppa per origine/destinazione vicine e orario
        // ST_SnapToGrid con 0.05 crea dei "blocchi" geografici di circa 5km
        const { rows: direttriciPotenziali } = await pool.query(`
            SELECT 
                start_datetime, 
                ST_SnapToGrid(origine::geometry, 0.05) as area_origine,
                ST_SnapToGrid(destinazione::geometry, 0.05) as area_destinazione,
                SUM(posti_richiesti) as totale_domanda,
                array_agg(id) as ids_richieste,
                ST_MakeLine(ST_Centroid(ST_Collect(origine::geometry)), 
                            ST_Centroid(ST_Collect(destinazione::geometry))) as rotta_media
            FROM richieste_pop_bus
            WHERE stato = 'in_attesa'
            GROUP BY start_datetime, area_origine, area_destinazione
            HAVING SUM(posti_richiesti) >= 5
        `);

        for (const direttrice of direttriciPotenziali) {
            await processaAttivazioneDirettrice(direttrice);
        }
    } catch (error) {
        console.error("Errore nel job di automazione PopBus:", error);
    }
};

/**
 * Crea la direttrice virtuale e associa le richieste
 */
const processaAttivazioneDirettrice = async (data) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Creazione dell'entità direttrice (il "bus virtuale")
        const dirResult = await client.query(`
            INSERT INTO direttrici_virtuali (
                linea_geografica, 
                stato, 
                partenza_prevista, 
                capacita_totale,
                posti_occupati
            ) VALUES ($1, 'in_formazione', $2, 20, $3)
            RETURNING id
        `, [data.rotta_media, data.start_datetime, data.totale_domanda]);

        const direttriceId = dirResult.rows[0].id;

        // 2. Associazione delle richieste (tabella di giunzione)
        for (const reqId of data.ids_richieste) {
            await client.query(`
                INSERT INTO direttrici_richieste (direttrice_id, richiesta_id) 
                VALUES ($1, $2)
            `, [direttriceId, reqId]);
        }

        // 3. Update stato richieste: segnate come 'convertita' per la direttrice
        await client.query(`
            UPDATE richieste_pop_bus 
            SET stato = 'convertita' 
            WHERE id = ANY($1)
        `, [data.ids_richieste]);

        await client.query('COMMIT');
        
        console.log(`Direttrice ${direttriceId} creata per ${data.totale_domanda} passeggeri.`);
        
        // 4. Qui il servizio notifiche invia l'alert agli autisti liberi in zona
        // await notificationService.inviaBroadcastAutisti(direttriceId);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Errore durante attivazione direttrice:", error);
        throw error;
    } finally {
        client.release();
    }
};