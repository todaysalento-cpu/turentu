import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { notifyUser } from '../services/notifications/notification.service.js';
import { v2 as cloudinary } from 'cloudinary';

const router = express.Router();

// Configurazione Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'tuo_cloud_name',
  api_key: process.env.CLOUDINARY_API_KEY || 'tua_api_key',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'tuo_api_secret',
});

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

    const hasGeo = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
    let query = '';

    if (hasGeo) {
      const parsedLat = parseFloat(lat);
      const parsedLng = parseFloat(lng);
      const parsedRadius = parseFloat(radius);

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
      query = `
        SELECT 
          id, titolo, categoria, descrizione, data_inizio, data_fine, 
          luogo_nome, indirizzo, citta, lat, lng, creato_da, created_at, immagine_url,
          0 AS distanza_km
        FROM public.eventi
        WHERE 1=1
      `;
    }

    if (categoria && categoria !== 'all' && categoria !== 'Tutti') {
      query += ` AND LOWER(categoria) = LOWER($${paramIndex})`;
      queryParams.push(categoria);
      paramIndex++;
    }

    if (nome && typeof nome === 'string' && nome.trim() !== '') {
      query += ` AND (titolo ILIKE $${paramIndex} OR descrizione ILIKE $${paramIndex})`;
      queryParams.push(`%${nome.trim()}%`);
      paramIndex++;
    }

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
// 3. API: Crea un nuovo evento (PROTETTA + Cloudinary Base64)
// ==========================================
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user?.id;
    const { 
      titolo, categoria, descrizione, data_inizio, data_fine, 
      luogo_nome, indirizzo, citta, lat, lng, immagine 
    } = req.body;

    if (!titolo || !categoria || !luogo_nome) {
      return res.status(400).json({ success: false, error: "Campi obbligatori mancanti" });
    }

    let immagineUrl = "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?q=80&w=600&auto=format&fit=crop";

    if (immagine && typeof immagine === 'string' && immagine.startsWith('data:image')) {
      const uploadResponse = await cloudinary.uploader.upload(immagine, {
        folder: "turentu_eventi",
      });
      immagineUrl = uploadResponse.secure_url;
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
      immagineUrl,
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
// 4. API: Modifica evento esistente (PROTETTA + Cloudinary Base64)
// ==========================================
router.put('/:id', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { 
      titolo, categoria, descrizione, data_inizio, data_fine, 
      luogo_nome, indirizzo, citta, lat, lng, immagine 
    } = req.body;

    if (!titolo || !categoria || !luogo_nome) {
      return res.status(400).json({ success: false, error: "Campi obbligatori mancanti" });
    }

    const checkEvent = await client.query('SELECT * FROM public.eventi WHERE id = $1', [id]);
    if (checkEvent.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Evento non trovato" });
    }

    let immagineUrl = checkEvent.rows[0].immagine_url;

    if (immagine && typeof immagine === 'string' && immagine.startsWith('data:image')) {
      const uploadResponse = await cloudinary.uploader.upload(immagine, {
        folder: "turentu_eventi",
      });
      immagineUrl = uploadResponse.secure_url;
    }

    const query = `
      UPDATE public.eventi 
      SET titolo = $1, categoria = $2, descrizione = $3, data_inizio = $4, data_fine = $5, 
          luogo_nome = $6, indirizzo = $7, citta = $8, lat = $9, lng = $10, immagine_url = $11
      WHERE id = $12
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
      immagineUrl,
      id
    ];

    const result = await client.query(query, values);

    return res.status(200).json({ 
      success: true, 
      message: "Evento aggiornato con successo", 
      data: result.rows[0] 
    });

  } catch (err) {
    console.error('❌ [API PUT /events/:id] Errore:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 5. API: Elimina evento (PROTETTA)
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