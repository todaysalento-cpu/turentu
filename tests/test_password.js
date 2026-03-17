import { pool } from '../db/db.js'; // il tuo pool Postgres
import bcrypt from 'bcryptjs';

async function updatePasswords() {
  try {
    // 1️⃣ Recupera tutti gli utenti senza password
    const res = await pool.query("SELECT id, nome FROM utente WHERE password IS NULL");
    
    for (const user of res.rows) {
      // 2️⃣ Genera hash bcrypt per la password 'prova123'
      const hash = await bcrypt.hash('prova123', 10);
      
      // 3️⃣ Aggiorna l'utente con la password hashata
      await pool.query("UPDATE utente SET password = $1 WHERE id = $2", [hash, user.id]);
      console.log(`✅ Password aggiornata per utente ${user.nome} (id: ${user.id})`);
    }

    console.log('✅ Tutte le password aggiornate!');
  } catch (err) {
    console.error('❌ Errore aggiornamento password:', err);
  } finally {
    pool.end();
  }
}

updatePasswords();
