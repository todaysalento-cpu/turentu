import { pool } from './db/db.js'; // Adatta il percorso
import polyline from 'polyline';

async function checkRoutes() {
    const client = await pool.connect();
    const res = await client.query("SELECT id, percorso_polyline FROM corse WHERE id IN (665, 739)");
    
    res.rows.forEach(c => {
        const coords = polyline.decode(c.percorso_polyline);
        console.log(`Corsa ${c.id}:`);
        console.log(`  -> Start: ${coords[0][0]}, ${coords[0][1]}`);
        console.log(`  -> End:   ${coords[coords.length - 1][0]}, ${coords[coords.length - 1][1]}`);
    });
    client.release();
}
checkRoutes();