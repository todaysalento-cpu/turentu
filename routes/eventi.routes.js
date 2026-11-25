import { fileURLToPath } from 'node:url';
import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { notifyUser } from '../services/notifications/notification.service.js';
import { v2 as cloudinary } from 'cloudinary';
import { generaCopertinaPartita } from '../services/eventi/copertina-partita.service.js';

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

    query += ` AND COALESCE(data_fine, data_inizio) > NOW()`;

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

// Consulta direttamente l'evento anche quando non rientra nei risultati della ricerca.
router.get('/:id/fermate', async (req, res, next) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) return res.sendStatus(400);
  try {
    const { rows } = await pool.query(`
      SELECT f.id, f.nome, f.indirizzo, f.attiva, f.verificata,
             ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lng
      FROM pixel_fermate f JOIN nodi_territoriali n ON n.id = f.nodo_territoriale_id
      WHERE n.evento_id = $1 AND n.attivo ORDER BY f.id
    `, [req.params.id]);
    return res.json({ success: true, data: rows });
  } catch (error) { return next(error); }
});

router.put('/:id/fermate/:fermataId', authMiddleware, async (req, res, next) => {
  if (![req.params.id, req.params.fermataId].every(id => /^[1-9]\d*$/.test(id))) return res.sendStatus(400);
  const { nome, indirizzo, lat, lng, attiva } = req.body ?? {};
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 180 ||
      (indirizzo != null && (typeof indirizzo !== 'string' || indirizzo.length > 250)) ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 ||
      Math.abs(lng) > 180 || (lat === 0 && lng === 0) || typeof attiva !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Dati fermata non validi' });
  }
  try {
    const { rows } = await pool.query(`
      UPDATE pixel_fermate f SET nome = $3, indirizzo = $4,
        verificata = f.verificata AND ST_Equals(f.posizione::geometry, ST_SetSRID(ST_MakePoint($5, $6), 4326)),
        posizione = ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, attiva = $7
      FROM nodi_territoriali n JOIN eventi e ON e.id = n.evento_id
      WHERE e.id = $1 AND f.id = $2 AND f.nodo_territoriale_id = n.id AND n.attivo
        AND (e.creato_da = $8 OR $9)
      RETURNING f.id, f.nome, f.indirizzo, f.attiva, f.verificata
    `, [req.params.id, req.params.fermataId, nome.trim(), indirizzo?.trim() || null,
      lng, lat, attiva, req.user.id, req.user.role === 'admin']);
    if (!rows.length) return res.sendStatus(404);
    return res.json({ success: true, data: rows[0] });
  } catch (error) { return next(error); }
});

// Copertine WebP statiche pubbliche, senza elaborazione dinamica.
router.get('/copertine/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^[a-z0-9][a-z0-9_-]{0,119}\.webp$/.test(filename)) {
    return res.sendStatus(404);
  }
  return res.sendFile(filename, {
    root: fileURLToPath(new URL('../assets/eventi/', import.meta.url)),
    maxAge: '30d',
    headers: {
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Copertina PNG pubblica, esclusivamente per gli eventi importati da US Lecce.
router.get('/:id/copertina.png', async (req, res) => {
  const { id } = req.params;
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) {
    return res.status(400).json({ success: false, error: 'ID evento non valido' });
  }

  try {
    const { rows: [evento] } = await pool.query(
      `SELECT e.id, e.titolo, e.descrizione, e.data_inizio
         FROM public.eventi e
         JOIN public.eventi_sorgenti_esterne s ON s.evento_id = e.id
        WHERE e.id = $1 AND s.sorgente = 'us-lecce'
        LIMIT 1`,
      [id]
    );
    if (!evento) return res.status(404).json({ success: false, error: 'Copertina non disponibile' });

    const image = await generaCopertinaPartita(evento);
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(image);
  } catch (error) {
    console.error('[EVENTI COPERTINA]', error);
    return res.status(500).json({ success: false, error: 'Errore generazione copertina' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[1-9]\d{0,18}$/.test(id) || (id.length === 19 && id > "9223372036854775807")) {
    return res.status(400).json({ success: false, error: "ID evento non valido" });
  }

  try {
    const { rows: [evento] } = await pool.query(
      `SELECT id, titolo, categoria, descrizione, data_inizio, data_fine,
              luogo_nome, indirizzo, citta, lat, lng, immagine_url
       FROM public.eventi WHERE id = $1::bigint`,
      [id],
    );
    if (!evento) {
      return res.status(404).json({ success: false, error: "Evento non trovato" });
    }
    return res.json({ success: true, data: evento });
  } catch (error) {
    console.error('[API GET /eventi/:id]', error.message);
    return res.status(500).json({ success: false, error: "Errore server" });
  }
});

export { router as eventiRouter };