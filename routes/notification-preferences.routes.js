import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { preference,id } from '../services/notifications/campaign-validation.js';

const router = express.Router();
const handle = fn => async (req,res) => {
  try { await fn(req,res); }
  catch (error) {
    console.error('[PREFERENZE NOTIFICHE]',error.code ?? error.name);
    res.status(500).json({error:'Operazione non riuscita.'});
  }
};
router.get('/preferences',authMiddleware,handle(async (req,res) => {
  const {rows:[row]} = await pool.query('SELECT marketing,personalization,territory,interests FROM notification_preferences WHERE user_id=$1',[req.user.id]);
  res.json(row ?? {marketing:false,personalization:false,territory:{},interests:[]});
}));
router.post('/preferences',authMiddleware,handle(async (req,res) => {
  const parsed = preference.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:'Preferenze non valide.'});
  const {marketing,personalization,territory,interests} = parsed.data;
  const {rows:[row]} = await pool.query(`INSERT INTO notification_preferences(user_id,marketing,personalization,territory,interests)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id) DO UPDATE
    SET marketing=excluded.marketing,personalization=excluded.personalization,territory=excluded.territory,interests=excluded.interests,updated_at=now()
    RETURNING marketing,personalization,territory,interests`,[req.user.id,marketing,personalization,territory,interests]);
  return res.json(row);
}));
router.post('/campaign-open',authMiddleware,handle(async (req,res) => {
  const recipient = id.safeParse(req.body?.recipientId);
  if (!recipient.success) return res.sendStatus(400);
  await pool.query(`UPDATE notification_campaign_recipients SET opened_at=coalesce(opened_at,now()),
    clicked_at=CASE WHEN $3 THEN coalesce(clicked_at,now()) ELSE clicked_at END
    WHERE id=$1 AND user_id=$2 AND status IN ('sending','accepted','uncertain')`,[recipient.data,req.user.id,req.body.clicked===true]);
  return res.sendStatus(204);
}));

router.get('/campaign-destination/:kind/:id',authMiddleware,handle(async (req,res) => {
  const parsed = id.safeParse(req.params.id);
  if (!parsed.success) return res.sendStatus(400);
  const queries = {
    booking: `SELECT 'Dettaglio prenotazione' AS title,c.origine_address,c.destinazione_address,c.start_datetime,p.posti_richiesti
      FROM prenotazioni p JOIN corse c ON c.id=p.corsa_id WHERE p.id=$1 AND p.cliente_id=$2`,
    ride: `SELECT 'Dettaglio corsa' AS title,c.origine_address,c.destinazione_address,c.start_datetime
      FROM corse c LEFT JOIN veicolo v ON v.id=c.veicolo_id WHERE c.id=$1 AND (v.driver_id=$2 OR EXISTS
        (SELECT 1 FROM prenotazioni p WHERE p.corsa_id=c.id AND p.cliente_id=$2))`,
    promotion: `SELECT c.title,c.body,c.image_url FROM notification_campaigns c
      JOIN notification_campaign_recipients r ON r.campaign_id=c.id
      WHERE r.id=$1 AND r.user_id=$2 AND r.status IN ('sending','accepted','uncertain') AND c.action->>'kind'='promotion'`,
  };
  const kind = req.params.kind;
  if (!Object.hasOwn(queries,kind)) return res.sendStatus(404);
  const {rows:[detail]} = await pool.query(queries[kind],[parsed.data,req.user.id]);
  if (!detail) return res.status(404).json({error:'Contenuto non disponibile.'});
  return res.json(detail);
}));
export default router;
