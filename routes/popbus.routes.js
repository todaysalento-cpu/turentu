import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { createCorsaFromDirettrice } from '../services/corsa/corsa.service.js';
import { notifyUser } from '../services/notifications/notification.service.js';
import { getLocalitaSafe } from '../utils/maps.util.js';

const router = express.Router();
router.use(authMiddleware);

// ==========================================
// ROTTA: GET Offerte PopBus attive per l'autista loggato
// ==========================================
router.get('/offerte/veicolo/:veicolo_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { veicolo_id } = req.params;
    const autistaId = req.user.id;

    console.log(`🔎 [GET OFFERTE] Recupero offerte PopBus attive per autista ID: ${autistaId} (Veicolo richiesto: ${veicolo_id})`);

    const result = await client.query(`
      SELECT 
        o.id, 
        o.direttrice_id, 
        o.autista_id,
        o.stato, 
        o.expires_at,
        d.tipo_servizio as classe, 
        -- Orario calcolato dal segmento o fallback sulla partenza prevista della direttrice
        COALESCE(s.start_datetime, d.partenza_prevista) as orario,
        d.distanza_totale_km,
        s.posti_occupati as posti_richiesti,
        -- Prezzo reale proveniente dal ricavo stimato del segmento
        COALESCE(s.ricavo_stimato, 0) as prezzo,
        
        -- Estrazione dei nomi dei nodi salvati e delle coordinate per il reverse geocoding di fallback
        n_start.nome_nodo as start_nome_db,
        ST_Y(n_start.posizione::geometry) AS start_lat,
        ST_X(n_start.posizione::geometry) AS start_lon,
        
        n_end.nome_nodo as end_nome_db,
        ST_Y(n_end.posizione::geometry) AS end_lat,
        ST_X(n_end.posizione::geometry) AS end_lon,
        
        COALESCE(s.start_node_id, d.start_node_id) as start_node_id,
        COALESCE(s.end_node_id, d.end_node_id) as end_node_id
      FROM offerte_autisti o
      JOIN direttrici_virtuali d ON o.direttrice_id = d.id
      LEFT JOIN segmenti s ON s.direttrice_id = d.id AND s.stato = 'attivo'
      LEFT JOIN nodi_direttrice n_start ON COALESCE(s.start_node_id, d.start_node_id) = n_start.id
      LEFT JOIN nodi_direttrice n_end ON COALESCE(s.end_node_id, d.end_node_id) = n_end.id
      WHERE o.autista_id = $1 
        AND o.stato = 'inviata' 
        AND o.expires_at > NOW()
    `, [autistaId]);

    console.log(`🔎 [GET OFFERTE] Trovate ${result.rows.length} offerte grezze dal DB. Conversione località in corso...`);

    // 🌍 Elaborazione e conversione dinamica delle coordinate in località reali (con supporto cache)
    const offerteArricchite = await Promise.all(result.rows.map(async (row) => {
      // 1. Origine
      let origine_address = row.start_nome_db;
      if (!origine_address || origine_address.trim() === '') {
        if (row.start_lat && row.start_lon) {
          origine_address = await getLocalitaSafe({ lat: row.start_lat, lon: row.start_lon });
        } else {
          origine_address = "Località Sconosciuta";
        }
      }

      // 2. Destinazione
      let destinazione_address = row.end_nome_db;
      if (!destinazione_address || destinazione_address.trim() === '') {
        if (row.end_lat && row.end_lon) {
          destinazione_address = await getLocalitaSafe({ lat: row.end_lat, lon: row.end_lon });
        } else {
          destinazione_address = "Località Sconosciuta";
        }
      }

      return {
        id: row.id,
        direttrice_id: row.direttrice_id,
        autista_id: row.autista_id,
        stato: row.stato,
        expires_at: row.expires_at,
        classe: row.classe,
        orario: row.orario,
        distanza_totale_km: row.distanza_totale_km,
        posti_richiesti: row.posti_richiesti,
        prezzo: row.prezzo,
        origine_address,
        destinazione_address,
        start_node_id: row.start_node_id,
        end_node_id: row.end_node_id
      };
    }));

    console.log(`🔎 [GET OFFERTE] Offerte elaborate con successo.`);
    console.log("📦 [DEBUG OFFERTA ARRICCHITA]:", JSON.stringify(offerteArricchite, null, 2));

    res.json({ offerte: offerteArricchite });
  } catch (err) {
    console.error("❌ [GET OFFERTE] Errore nel recupero offerte PopBus:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// POST: Accetta offerta PopBus
// ==========================================
router.post('/:offerta_id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const offertaId = Number(req.params.offerta_id);
    const autistaId = req.user.id;

    console.log(`🟢 [ACCETTA] Avvio processo accettazione - Offerta ID: ${offertaId}, Autista ID: ${autistaId}`);

    await client.query('BEGIN');

    // 1. Blocco l'offerta (FOR UPDATE) e verifico che sia ancora valida
    const offertaRes = await client.query(`
      SELECT o.id, o.direttrice_id, d.stato as dir_stato
      FROM offerte_autisti o
      JOIN direttrici_virtuali d ON o.direttrice_id = d.id
      WHERE o.id = $1 AND o.stato = 'inviata' AND o.expires_at > NOW()
      FOR UPDATE`, [offertaId]);

    if (!offertaRes.rows.length) {
      console.warn(`⚠️ [ACCETTA] Offerta ${offertaId} non trovata, già gestita o scaduta.`);
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Offerta non disponibile o scaduta' });
    }

    const { direttrice_id } = offertaRes.rows[0];
    console.log(`✅ [ACCETTA] Offerta valida trovata. Direttrice ID associata: ${direttrice_id}`);

    // 2. Transizione stato: Accetto questa, scarto le altre
    await client.query(`UPDATE offerte_autisti SET stato = 'accettata' WHERE id = $1`, [offertaId]);
    await client.query(`UPDATE offerte_autisti SET stato = 'scaduta' WHERE direttrice_id = $1 AND id != $2`, [direttrice_id, offertaId]);

    // 3. Creazione Corsa Aggregata
    console.log(`🚗 [ACCETTA] Creazione corsa da direttrice ${direttrice_id}...`);
    const { corsa } = await createCorsaFromDirettrice(direttrice_id, autistaId, client);
    console.log(`✨ [ACCETTA] Corsa creata con successo. ID Corsa: ${corsa?.id}`);

    // 4. Update finale direttrice
    await client.query(`UPDATE direttrici_virtuali SET stato = 'confermata', corsa_id = $1 WHERE id = $2`, [corsa.id, direttrice_id]);

    await client.query('COMMIT');
    console.log(`💾 [ACCETTA] Transazione completata (COMMIT) con successo.`);

    // 5. Notifiche (Post-Commit)
    const io = getIO();
    
    const targetRoom = `autista_${autistaId}`;
    console.log(`📡 [ACCETTA] Invio evento socket 'nuova_corsa_popbus' alla room '${targetRoom}'`);
    io.to(targetRoom).emit('nuova_corsa_popbus', corsa);
    
    // Notifica tutti i clienti coinvolti nella direttrice
    const { rows: clienti } = await client.query(`
      SELECT DISTINCT cliente_id FROM richieste_pop_bus 
      WHERE corsa_id = $1`, [corsa.id]);

    console.log(`👥 [ACCETTA] Trovati ${clienti.length} clienti da notificare per la corsa ${corsa.id}`);

    for (const c of clienti) {
      await notifyUser(c.cliente_id, {
        type: 'popbus',
        message: 'La tua corsa PopBus è stata confermata da un autista!',
        data: { corsaId: corsa.id }
      });
    }

    res.json({ ok: true, corsa_id: corsa.id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [ACCETTA] ERRORE CRITICO - Eseguito ROLLBACK:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as popbusRouter };