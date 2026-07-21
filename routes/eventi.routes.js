import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { notifyUser } from '../services/notifications/notification.service.js';

const router = express.Router();

// ==========================================
// 1. API: Cerca Eventi (PUBBLICA - Non richiede auth)
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

// ==========================================
// 2. API: Ottieni i "miei" eventi (PROTETTA)
// ==========================================
router.get('/miei', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user?.id; 
    if (!userId) {
      return res.status(401).json({ success: false, error: "Utente non autenticato" });
    }

    const result = await client.query(
      'SELECT * FROM public.eventi WHERE creato_da = $1 ORDER BY data_inizio DESC',
      [userId]
    );

    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ [API /events/miei] Errore:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 3. API: Crea un nuovo evento (PROTETTA)
// ==========================================
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user?.id;
    const { 
      titolo, categoria, descrizione, data_inizio, data_fine, 
      luogo_nome, indirizzo, citta, lat, lng, immagine_url 
    } = req.body;

    if (!titolo || !categoria || !luogo_nome) {
      return res.status(400).json({ success: false, error: "Campi obbligatori mancanti" });
    }

    const query = `
      INSERT INTO public.eventi (
        titolo, categoria, descrizione, data_inizio, data_fine, 
        luogo_nome, indirizzo, citta, lat, lng, immagine_url, creato_da
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;

    const values = [
      titolo,
      categoria.toLowerCase(),
      descrizione || null,
      data_inizio || new Date(),
      data_fine || null,
      luogo_nome,
      indirizzo || null,
      citta || null,
      lat ? parseFloat(lat) : null,
      lng ? parseFloat(lng) : null,
      immagine_url || null,
      userId || null
    ];

    const result = await client.query(query, values);

    return res.status(201).json({ 
      success: true, 
      message: "Evento creato con successo", 
      data: result.rows[0] 
    });

  } catch (err) {
    console.error('❌ [API POST /events] Errore:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 4. API: Elimina evento (PROTETTA)
// ==========================================
router.delete('/:id', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('DELETE FROM public.eventi WHERE id = $1', [id]);
    return res.status(200).json({ success: true, message: "Evento eliminato" });
  } catch (err) {
    console.error('❌ [API DELETE /events] Errore:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

export { router as eventiRouter };