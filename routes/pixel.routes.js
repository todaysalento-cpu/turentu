// routes/pixel.routes.js
import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { pixelCollaudoEnabled } from '../services/pixel/pixel-collaudo-mode.js';
import { ensurePixelStopsForNode } from '../services/pixel/pixel-stop-acquisition.service.js';
import { registraFermataTerritorialePixel } from '../services/pixel/pixel-territorial-orchestrator.service.js';

const pixelRouter = Router();

function parseNodoId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Catalogo operativo: la modalita' collaudo non aggira i requisiti di attivazione.
pixelRouter.get('/fermate', async (req, res) => {
  try {
    const nodoId = parseNodoId(req.query.nodo_id);
    if (nodoId === null) {
      return res.status(400).json({ success: false, error: 'nodo_id non valido' });
    }

    const collaudo = pixelCollaudoEnabled();
    const read = () => pool.query(`
      SELECT fermata_id AS id, nome, indirizzo, lat, lon, tipi_veicolo_ammessi
      FROM public.pixel_fermate_per_nodo($1::bigint)
      ORDER BY nome, fermata_id`, [nodoId]);
    let { rows } = await read();
    if (collaudo && rows.length === 0) {
      // Solo discovery informativa: non persiste dati Google Places.
      const acquisition = await ensurePixelStopsForNode(nodoId);
      console.info('[PIXEL COLLAUDO] Acquisizione:', { nodoId, ...acquisition });
      ({ rows } = await read());
    }

    return res.status(200).json({
      success: true,
      nodo_id: nodoId,
      modalita: collaudo ? 'collaudo' : 'commerciale',
      fermate: rows.map(row => ({
        id: Number(row.id),
        nome: row.nome,
        indirizzo: row.indirizzo,
        lat: Number(row.lat),
        lon: Number(row.lon),
        tipi_veicolo_ammessi: row.tipi_veicolo_ammessi || [],
      })),
    });
  } catch (error) {
    console.error('[PIXEL] Errore caricamento fermate:', error);
    return res.status(500).json({ success: false, error: 'Errore interno durante il caricamento delle fermate' });
  }
});

// Fixture solo per UI di collaudo: mai prenotabili.
pixelRouter.get('/fermate-test', async (req, res) => {
  if (!pixelCollaudoEnabled()) {
    return res.status(404).json({ success: false, error: 'Endpoint non disponibile' });
  }
  const nodoId = parseNodoId(req.query.nodo_id);
  if (nodoId === null) {
    return res.status(400).json({ success: false, error: 'nodo_id non valido' });
  }
  try {
    const { rows: nodes } = await pool.query(`
      SELECT id FROM public.nodi_territoriali
      WHERE id = $1::bigint AND attivo = TRUE LIMIT 1`, [nodoId]);
    if (!nodes.length) {
      return res.status(404).json({ success: false, error: 'Nodo territoriale non disponibile' });
    }
    const { rows } = await pool.query(`
      SELECT f.id, f.nome, f.indirizzo,
             ST_Y(f.posizione::geometry) AS lat,
             ST_X(f.posizione::geometry) AS lon,
             f.tipi_veicolo_ammessi, f.verificata
      FROM public.pixel_fixture_stops x
      JOIN public.pixel_fermate f ON f.id = x.fermata_id
      WHERE f.nodo_territoriale_id = $1::bigint
        AND f.attiva = FALSE AND f.verificata = FALSE
      ORDER BY f.id`, [nodoId]);
    return res.status(200).json({
      success: true,
      nodo_id: nodoId,
      modalita: 'collaudo',
      persistite: true,
      prenotabili: false,
      fermate: rows.map(row => ({
        id: Number(row.id),
        nome: row.nome,
        indirizzo: row.indirizzo,
        lat: Number(row.lat),
        lon: Number(row.lon),
        tipi_veicolo_ammessi: row.tipi_veicolo_ammessi || [],
        operativa_test: false,
        verificata: false,
        prenotabile: false,
      })),
    });
  } catch (error) {
    console.error('[PIXEL TEST] Errore lettura fixture:', error);
    return res.status(500).json({ success: false, error: 'Errore interno durante il caricamento delle fermate di collaudo' });
  }
});

// Registrazione amministrativa: solo dati indipendenti da Google Places.
// Le dichiarazioni dell'amministratore sono registrate, non costituiscono certificazione.
pixelRouter.post('/fermate/registrazione', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: 'Corpo richiesta non valido' });
    }
    const {
      nodo_territoriale_id, nome, indirizzo = null, lat, lon,
      fonte, riferimento_fonte, autorizzazione_uso_dati, conferma_punto_salita,
    } = body;
    const nodo = Number(nodo_territoriale_id);
    if (!Number.isSafeInteger(nodo) || nodo <= 0 ||
        typeof nome !== 'string' || !nome.trim() || nome.length > 250 ||
        (indirizzo !== null && (typeof indirizzo !== 'string' || indirizzo.length > 500)) ||
        typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180 ||
        !['rilievo_operatore', 'fonte_pubblica_riutilizzabile'].includes(fonte) ||
        typeof riferimento_fonte !== 'string' || !riferimento_fonte.trim() || riferimento_fonte.length > 1000 ||
        autorizzazione_uso_dati !== true || conferma_punto_salita !== true) {
      return res.status(400).json({ success: false, error: 'Dati di registrazione non validi o attestazioni mancanti' });
    }

    const result = await registraFermataTerritorialePixel({
      nodo_territoriale_id: nodo,
      nome: nome.trim(), indirizzo, lat, lon,
      fonte, riferimento_fonte: riferimento_fonte.trim(),
      autorizzazione_uso_dati, conferma_punto_salita,
    });
    return res.status(result.inserted ? 201 : 200).json({ success: true, ...result });
  } catch (error) {
    console.error('[PIXEL] Registrazione fermata fallita:', error);
    return res.status(500).json({ success: false, error: 'Registrazione fermata non riuscita' });
  }
});

export default pixelRouter;
