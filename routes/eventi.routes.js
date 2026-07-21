import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { notifyUser } from '../services/notifications/notification.service.js';

const router = express.Router();
router.use(authMiddleware);

// ==========================================
// API: Cerca Eventi (con log dettagliati)
// ==========================================
router.get('/search', async (req, res) => {
  const client = await pool.connect();
  try {
    const { 
      categoria, 
      quando, 
      nome, 
      lat, 
      lng, 
      radius = 50 
    } = req.query;

    console.log("📥 [API /events/search] Parametri ricevuti:", {
      categoria,
      quando,
      nome,
      lat,
      lng,
      radius
    });

    const queryParams = [];
    let paramIndex = 1;

    // Se sono presenti coordinate valide, usiamo la struttura con Haversine incorporata
    const hasGeo = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));

    let query = '';

    if (hasGeo) {
      const parsedLat = parseFloat(lat);
      const parsedLng = parseFloat(lng);
      const parsedRadius = parseFloat(radius);

      // Inseriamo lat e lng iniziali per il calcolo della distanza
      queryParams.push(parsedLat, parsedLng);
      const latParamIdx = paramIndex++;
      const lngParamIdx = paramIndex++;

      query = `
        SELECT * FROM (
          SELECT 
            id, titolo, categoria, descrizione, data_inizio, data_fine, 
            luogo_nome, indirizzo, citta, lat, lng, creato_da, created_at, immagine_url,
            (
              6371 * acos(
                cos(radians($${latParamIdx})) * cos(radians(lat)) * 
                cos(radians(lng) - radians($${lngParamIdx})) + 
                sin(radians($${latParamIdx})) * sin(radians(lat))
              )
            ) AS distanza_km
          FROM public.eventi
          WHERE lat IS NOT NULL AND lng IS NOT NULL
        ) sub
        WHERE distanza_km <= $${paramIndex}
      `;
      queryParams.push(parsedRadius);
      paramIndex++;

    } else {
      // Query standard senza geolocalizzazione
      query = `
        SELECT 
          id, titolo, categoria, descrizione, data_inizio, data_fine, 
          luogo_nome, indirizzo, citta, lat, lng, creato_da, created_at, immagine_url,
          0 AS distanza_km
        FROM public.eventi
        WHERE 1=1
      `;
    }

    // 1. Filtro per Categoria (se presente e diversa da "all" o "Tutti")
    if (categoria && categoria !== 'all' && categoria !== 'Tutti') {
      query += ` AND LOWER(categoria) = LOWER($${paramIndex})`;
      queryParams.push(categoria);
      paramIndex++;
    }

    // 2. Filtro per Nome/Parola chiave
    if (nome && typeof nome === 'string' && nome.trim() !== '') {
      query += ` AND (titolo ILIKE $${paramIndex} OR descrizione ILIKE $${paramIndex})`;
      queryParams.push(`%${nome.trim()}%`);
      paramIndex++;
    }

    // 3. Filtro temporale (quando)
    if (quando && quando !== 'any' && quando !== 'Tutti') {
      if (quando === 'today') {
        query += ` AND data_inizio::date = CURRENT_DATE`;
      } else if (quando === 'tomorrow') {
        query += ` AND data_inizio::date = CURRENT_DATE + INTERVAL '1 day'`;
      } else if (quando === 'weekend') {
        query += ` AND data_inizio >= date_trunc('week', CURRENT_DATE) + INTERVAL '5 days' 
                   AND data_inizio < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days' + INTERVAL '1 day'`;
      }
    }

    // Ordinamento cronologico predefinito
    query += ` ORDER BY data_inizio ASC LIMIT 50;`;

    console.log("🛠️ [API /events/search] Query SQL generata:\n", query);
    console.log("📦 [API /events/search] Parametri passati alla query:", queryParams);

    const { rows } = await client.query(query, queryParams);

    console.log(`✅ [API /events/search] Risultati trovati dal DB: ${rows.length}`);

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });

  } catch (err) {
    console.error('❌ [API /events/search] Errore critico:', err);
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  } finally {
    client.release();
  }
});

export { router as eventiRouter };