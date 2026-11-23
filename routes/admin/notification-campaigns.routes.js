import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { pool } from '../../db/db.js';
import { categories, interests, draft, filters, id } from '../../services/notifications/campaign-validation.js';
import { previewAudience, materializeAudience } from '../../services/notifications/campaign-audience.service.js';
import { eventIsCurrent, sendCampaignPush } from '../../services/notifications/campaign-worker.service.js';
import { z } from 'zod';
import { ruleKinds, maxSourceId } from '../../services/notifications/campaign-rules.service.js';

const router = express.Router();
const upload = multer({ limits: { fileSize: 1000000, files: 1 } });
const wrap = handler => async (req,res,next) => {
  try { await handler(req,res); }
  catch (error) { next(error); }
};
const campaignShape = ['name','category','title','body','image_url','purpose','action','filters','priority'];
const fields = campaignShape.join(',');
const params = values => values.map((_,index) => '$' + (index+1)).join(',');
const audit = (db,actor,campaign,operation,details={}) =>
  db.query('INSERT INTO notification_campaign_audit(actor_id,campaign_id,operation,details) VALUES ($1,$2,$3,$4)',[actor,campaign,operation,details]);
async function transaction(handler) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const output = await handler(db); await db.query('COMMIT'); return output; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
function reject(status,message) { throw Object.assign(new Error(message),{status}); }

router.get('/event-context/:id',wrap(async (req,res) => {
  const eventId=id.parse(req.params.id);
  const {rows:[event]}=await pool.query("SELECT id,titolo,citta,luogo_nome,immagine_url,data_inizio,lat,lng FROM public.eventi WHERE id=$1",[eventId]);
  if (!event || !(await eventIsCurrent(pool,{kind:'event',value:eventId}))) reject(404,'Evento non pubblicato o già iniziato.');
  const [nodes,stops]=event.lat==null || event.lng==null ? [{rows:[]},{rows:[]}] : await Promise.all([
    pool.query(`SELECT id,nome FROM public.nodi_territoriali WHERE attivo AND
      ST_DWithin(posizione::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,15000)
      ORDER BY ST_Distance(posizione::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) LIMIT 5`,[event.lng,event.lat]),
    pool.query(`SELECT id,nodo_territoriale_id FROM public.pixel_fermate WHERE attiva AND
      ST_DWithin(posizione::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,15000)
      ORDER BY ST_Distance(posizione::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) LIMIT 8`,[event.lng,event.lat]),
  ]);
  const {rows:directives}=nodes.rows.length ? await pool.query(`SELECT id,nodi FROM public.pixel_direttrici d
    WHERE d.stato='attiva' AND EXISTS (SELECT 1 FROM unnest(d.nodi) n WHERE n::text=ANY($1::text[]))
    ORDER BY id LIMIT 12`,[nodes.rows.map(node=>String(node.id))]) : {rows:[]};
  res.json({event,nodes:nodes.rows,stops:stops.rows,directives});
}));
router.get('/options',
 (req,res) => res.json({categories,interests}));
router.get('/',wrap(async (req,res) => {
  const term = String(req.query.q ?? '').slice(0,100);
  const status = String(req.query.status ?? '').slice(0,30);
  const days = z.coerce.number().int().min(1).max(365).catch(30).parse(req.query.days);
  const page = z.coerce.number().int().min(1).max(10000).catch(1).parse(req.query.page);
  const sort = req.query.sort === 'name' ? 'c.name,c.id DESC' : 'c.created_at DESC,c.id DESC';
  const [rows, dashboard, daily, reach] = await Promise.all([
    pool.query(`SELECT c.*,coalesce(r.targets,0) AS targets,coalesce(r.accepted,0) AS accepted,
          coalesce(r.opened,0) AS opened,coalesce(r.clicked,0) AS clicked,coalesce(r.errors,0) AS errors,
          coalesce(r.attempts,0) AS attempts,coalesce(r.uncertain,0) AS uncertain,coalesce(r.invalid,0) AS invalid
        FROM notification_campaigns c LEFT JOIN LATERAL (
          SELECT count(*)::int AS targets,count(*) FILTER (WHERE status='accepted')::int AS accepted,
            count(opened_at)::int AS opened,count(clicked_at)::int AS clicked,
            count(*) FILTER (WHERE status IN ('failed','invalid','uncertain'))::int AS errors,
            count(*) FILTER (WHERE status='uncertain')::int AS uncertain,
            count(*) FILTER (WHERE status='invalid')::int AS invalid,sum(attempts)::int AS attempts
          FROM notification_campaign_recipients WHERE campaign_id=c.id
        ) r ON true WHERE ($1='' OR c.name ILIKE '%'||$1||'%') AND ($2='' OR c.status=$2)
        ORDER BY ${sort} LIMIT 26 OFFSET $3`,[term,status,(page-1)*25]),
    pool.query(`SELECT count(*) FILTER (WHERE status='programmata')::int AS scheduled,
      count(*) FILTER (WHERE status IN ('in_preparazione','in_invio'))::int AS active,
      count(*) FILTER (WHERE status='fallita')::int AS failed
      FROM notification_campaigns WHERE created_at>=now()-make_interval(days=>$1::int) OR status IN ('programmata','in_preparazione','in_invio')`,[days]),
    pool.query(`SELECT to_char(timezone('Europe/Rome',finished_at),'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE outcome='accepted')::int AS accepted,
      count(*) FILTER (WHERE outcome IN ('invalid','failed','uncertain'))::int AS errors
      FROM notification_campaign_attempts WHERE finished_at>=now()-make_interval(days=>$1::int)
      GROUP BY 1 ORDER BY 1`,[days]),
    previewAudience(pool,{},'operativa'),
  ]);
  const { rows:[totals] } = await pool.query(`SELECT
    count(*) FILTER (WHERE r.status='accepted')::int AS accepted,count(opened_at)::int AS opened
    FROM notification_campaign_recipients r JOIN notification_campaigns c ON r.campaign_id=c.id
    WHERE c.scheduled_at>=now()-make_interval(days=>$1::int)`,[days]);
  res.json({ items:rows.rows.slice(0,25), more:rows.rows.length>25, daily:daily.rows, reach,
    metrics:{...dashboard.rows[0],...totals} });
}));
router.post('/drafts',wrap(async (req,res) => {
  const { campaignId, value } = z.object({campaignId:id.optional(),value:draft}).strict().parse(req.body);
  const values = campaignShape.map(key => value[key]);
  const row = await transaction(async db => {
    const {rows:[item]} = campaignId
      ? await db.query(`UPDATE notification_campaigns SET (${fields})=(${params(values)}),updated_at=now()
          WHERE id=$10 AND status='bozza' RETURNING *`,[...values,campaignId])
      : await db.query(`INSERT INTO notification_campaigns(${fields},created_by)
          VALUES (${params([...values,req.user.id])}) RETURNING *`,[...values,req.user.id]);
    if (!item) reject(409,'La campagna non è modificabile.');
    await audit(db,req.user.id,item.id,campaignId?'edit':'create');
    return item;
  });
  res.json(row);
}));
router.post('/preview',wrap(async (req,res) => {
  const value = draft.parse(req.body);
  res.json(await previewAudience(pool,value.filters,value.purpose));
}));
router.get('/segments',wrap(async (req,res) => {
  const {rows} = await pool.query('SELECT id,name,filters FROM notification_segments ORDER BY name');
  res.json(rows);
}));
router.post('/segments',wrap(async (req,res) => {
  const value = z.object({name:z.string().trim().min(1).max(100),filters}).strict().parse(req.body);
  res.json(await transaction(async db => {
    const {rows:[segment]} = await db.query('INSERT INTO notification_segments(name,filters,created_by) VALUES ($1,$2,$3) RETURNING id,name,filters',[value.name,value.filters,req.user.id]);
    await audit(db,req.user.id,null,'segment_create',{id:segment.id});
    return segment;
  }));
}));

router.get('/rules',wrap(async (req,res) => {
  const {rows}=await pool.query("SELECT r.id,r.kind,r.enabled,r.segment_id,s.name AS segment FROM notification_campaign_rules r JOIN notification_segments s ON s.id=r.segment_id ORDER BY r.id DESC");
  res.json({items:rows,workerEnabled:process.env.NOTIFICATION_CAMPAIGNS_AUTOMATION==='1'});
}));
router.post('/rules',wrap(async (req,res) => {
  const {kind,segmentId}=z.object({kind:z.enum(ruleKinds),segmentId:id}).strict().parse(req.body);
  res.json(await transaction(async db => {
    const {rows:[rule]}=await db.query('INSERT INTO notification_campaign_rules(kind,segment_id,created_by) VALUES ($1,$2,$3) RETURNING *',[kind,segmentId,req.user.id]);
    await audit(db,req.user.id,null,'rule_create',{ruleId:rule.id});
    return rule;
  }));
}));
router.post('/rules/:id/status',wrap(async (req,res) => {
  const ruleId=id.parse(req.params.id);
  const {enabled,confirmed}=z.object({enabled:z.boolean(),confirmed:z.boolean()}).strict().parse(req.body);
  if (enabled && !confirmed) reject(400,'Conferma l’abilitazione della regola automatica.');
  res.json(await transaction(async db => {
    const {rows:[rule]}=await db.query('SELECT * FROM notification_campaign_rules WHERE id=$1 FOR UPDATE',[ruleId]);
    if (!rule) reject(404,'Regola assente.');
    if (rule.enabled===enabled) return rule;
    const source=enabled ? (await db.query(maxSourceId[rule.kind])).rows[0].id : rule.start_after;
    const {rows:[updated]}=await db.query('UPDATE notification_campaign_rules SET enabled=$2,start_after=$3 WHERE id=$1 RETURNING *',[ruleId,enabled,source]);
    await audit(db,req.user.id,null,enabled?'rule_enable':'rule_disable',{ruleId});
    return updated;
  }));
}));
router.get('/media',
wrap(async (req,res) => {
  const {rows} = await pool.query('SELECT id,name,url FROM notification_media ORDER BY id DESC LIMIT 100');
  res.json(rows);
}));
router.post('/media',upload.single('image'),wrap(async (req,res) => {
  const bytes = req.file?.buffer;
  const jpeg = bytes?.subarray(0,3).equals(Buffer.from([255,216,255]));
  const png = bytes?.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!jpeg && !png) reject(400,'Carica un file JPG o PNG fino a 1 MB.');
  cloudinary.config({ cloud_name:process.env.CLOUDINARY_CLOUD_NAME, api_key:process.env.CLOUDINARY_API_KEY, api_secret:process.env.CLOUDINARY_API_SECRET, secure:true });
  const url = await new Promise((resolve,rejectUpload) => {
    cloudinary.uploader.upload_stream({folder:'turentu_notifiche',resource_type:'image',format:'jpg'},
      (error,result) => error ? rejectUpload(error) : resolve(result.secure_url)).end(bytes);
  });
  res.json(await transaction(async db => {
    const {rows:[media]} = await db.query('INSERT INTO notification_media(name,url,created_by) VALUES ($1,$2,$3) RETURNING id,name,url',
      [req.file.originalname.slice(0,180),url,req.user.id]);
    await audit(db,req.user.id,null,'media_upload',{id:media.id});
    return media;
  }));
}));
router.post('/:id/duplicate',wrap(async (req,res) => {
  const campaignId = id.parse(req.params.id);
  res.json(await transaction(async db => {
    const {rows:[item]} = await db.query(`INSERT INTO notification_campaigns(${fields},created_by)
      SELECT left(name,90)||' (copia)',category,title,body,image_url,purpose,action,filters,priority,$2
      FROM notification_campaigns WHERE id=$1 RETURNING *`,[campaignId,req.user.id]);
    if (!item) reject(404,'Campagna non trovata.');
    await audit(db,req.user.id,item.id,'duplicate',{from:campaignId});
    return item;
  }));
}));
router.post('/:id/schedule',wrap(async (req,res) => {
  const campaignId = id.parse(req.params.id);
  const value = z.object({when:z.iso.datetime({offset:true}).nullable(),expectedTokens:z.number().int().positive(),
    fingerprint:z.string().regex(/^[a-f0-9]{64}$/), updatedAt:z.iso.datetime({offset:true})}).strict().parse(req.body);
  if (value.when && Date.parse(value.when)<=Date.now()) reject(400,'Scegli una data futura.');
  res.json(await transaction(async db => {
    const {rows:[item]} = await db.query("SELECT * FROM notification_campaigns WHERE id=$1 AND status='bozza' FOR UPDATE",[campaignId]);
    if (!item || new Date(item.updated_at).toISOString()!==new Date(value.updatedAt).toISOString()) reject(409,'Bozza modificata. Ripeti anteprima e conferma.');
    if (!item.title || !item.body) reject(400,'Inserisci titolo e messaggio.');
    if (!(await eventIsCurrent(db,item.action))) reject(400,'Evento assente o già iniziato.');
    await materializeAudience(db,item);
    const {rows:[count]} = await db.query("SELECT count(*)::int AS tokens,encode(sha256(convert_to(coalesce(string_agg(user_id::text||':'||token_hash,',' ORDER BY token_hash),''),'UTF8')),'hex') AS fingerprint FROM notification_campaign_recipients WHERE campaign_id=$1",[campaignId]);
    if (count.tokens!==value.expectedTokens || count.fingerprint!==value.fingerprint) reject(409,'Il pubblico è cambiato. Aggiorna l’anteprima.');
    const {rows:[scheduled]} = await db.query(`UPDATE notification_campaigns SET status='programmata',
      scheduled_at=coalesce($2::timestamptz,now()),updated_at=now() WHERE id=$1 RETURNING *`,[campaignId,value.when]);
    await audit(db,req.user.id,campaignId,'schedule',{tokens:count.tokens,when:scheduled.scheduled_at});
    return scheduled;
  }));
}));
router.post('/:id/cancel',wrap(async (req,res) => {
  const campaignId = id.parse(req.params.id);
  res.json(await transaction(async db => {
    const {rows:[item]} = await db.query(`UPDATE notification_campaigns SET status='annullata',updated_at=now(),finished_at=now()
      WHERE id=$1 AND status='programmata' RETURNING *`,[campaignId]);
    if (!item) reject(409,'Puoi annullare soltanto un invio programmato.');
    await db.query("UPDATE notification_campaign_recipients SET status='excluded' WHERE campaign_id=$1 AND status='pending'",[campaignId]);
    await audit(db,req.user.id,campaignId,'cancel');
    return item;
  }));
}));

router.get('/contacts',wrap(async (req,res) => {
  const query = z.string().trim().min(1).max(120).parse(req.query.q);
  const {rows} = await pool.query(`SELECT id::text AS id,nome,email,tipo
    FROM utente WHERE eliminato_il IS NULL AND
      (id::text=$1 OR (length($1)>=2 AND (strpos(lower(coalesce(nome,'')),lower($1))>0
        OR strpos(lower(coalesce(email,'')),lower($1))>0)))
    ORDER BY (id::text=$1) DESC,nome NULLS LAST,id LIMIT 12`,[query]);
  res.json(rows);
}));
router.post('/test',wrap(async (req,res) => {
  if (process.env.NOTIFICATION_CAMPAIGNS_TEST!=='1') reject(403,'Invii di test disabilitati.');
  const {recipientId,...content} = z.object({recipientId:id.optional()}).passthrough().parse(req.body);
  const item = draft.parse(content);
  if (!item.title || !item.body || !(await eventIsCurrent(pool,item.action))) reject(400,'Completa il messaggio o scegli un evento futuro.');
  const allowed = new Set((process.env.NOTIFICATION_TEST_USER_IDS ?? '').split(',').map(value=>value.trim()));
  if (!allowed.has(String(req.user.id))) reject(403,'Account di test non autorizzato.');
  const targetId = recipientId ?? String(req.user.id);
  const testContacts = new Set((process.env.NOTIFICATION_TEST_RECIPIENT_IDS ?? '').split(',').map(value=>value.trim()));
  if (targetId !== String(req.user.id) && !testContacts.has(targetId)) {
    reject(403,'Contatto non autorizzato a ricevere notifiche di test.');
  }
  const {rows:[dest]} = await pool.query(`SELECT t.push_token FROM utente_push_tokens t
    WHERE t.user_id=$1 AND t.push_token ~ '^[A-Za-z0-9_:-]{40,}$'
    AND NOT EXISTS (SELECT 1 FROM utente_push_tokens x WHERE x.push_token=t.push_token AND x.user_id<>t.user_id)
    AND EXISTS (SELECT 1 FROM utente u WHERE u.id=t.user_id AND u.eliminato_il IS NULL)
    ORDER BY t.created_at DESC NULLS LAST LIMIT 1`,[targetId]);
  if (!dest) reject(400,'Nessun token FCM per questo account.');
  await audit(pool,req.user.id,null,'test_attempt',{recipientId:targetId});
  const result = await sendCampaignPush({...item,id:'test'},dest.push_token,'test-' + Date.now());
  await audit(pool,req.user.id,null,'test_result',{accepted:!!result?.success,recipientId:targetId});
  if (!result?.success) reject(502,'Firebase non ha confermato l’invio di test.');
  res.json({accepted:true});
}));
router.use((error,req,res,next) => {
  if (error instanceof z.ZodError) return res.status(400).json({error:error.issues.map(issue=>issue.path.join('.') + ' ' + issue.message).join('. ')});
  if (error instanceof multer.MulterError) return res.status(400).json({error:'File non valido o oltre 1 MB.'});
  if (error.code==='23505') return res.status(409).json({error:'Nome già in uso.'});
  if (error.status) return res.status(error.status).json({error:error.message});
  console.error('[CENTRO NOTIFICHE]',error.code ?? error.name);
  return res.status(500).json({error:'Operazione non riuscita.'});
});
export default router;
