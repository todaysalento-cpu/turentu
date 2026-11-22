import { pool } from '../../db/db.js';
import { sendPush } from './push.service.js';
import { queueAutomaticCampaigns, campaignSourceIsCurrent } from './campaign-rules.service.js';

const LOCK = 481602010;
const invalidCodes = new Set(['messaging/registration-token-not-registered','messaging/invalid-registration-token']);
const retryCodes = new Set(['messaging/message-rate-exceeded','messaging/device-message-rate-exceeded','messaging/quota-exceeded']);
const matchingToken = `SELECT t.push_token FROM utente_push_tokens t
  JOIN utente u ON u.id=t.user_id
  WHERE t.user_id=$1 AND encode(sha256(convert_to(t.push_token,'UTF8')),'hex')=$2
  AND u.eliminato_il IS NULL
  AND NOT EXISTS (SELECT 1 FROM utente_push_tokens x WHERE x.push_token=t.push_token AND x.user_id<>u.id)
  AND NOT EXISTS (SELECT 1 FROM notification_invalid_tokens x WHERE x.token_hash=$2)`;

export function sendCampaignPush(campaign, token, id, send = sendPush) {
  const { action } = campaign;
  return send(token,campaign.title,campaign.body,{
    type: action.kind === 'event' ? 'event' : 'campaign',
    ...(action.kind === 'event' ? { eventId: action.value } : {}),
    ...(campaign.image_url ? { imageUrl: campaign.image_url } : {}),
    campaignId: campaign.id, campaignRecipientId: id, notificationId: 'campaign-' + id,
    campaignAction: action.kind, ...(action.value ? { campaignValue: action.value } : {}),
  }, { priority: campaign.priority });
}

export async function eventIsCurrent(db, action) {
  if (action.kind !== 'event') return true;
  const { rowCount } = await db.query(
    "SELECT 1 FROM public.eventi WHERE id=$1 AND data_inizio>now() AND lower(coalesce(to_jsonb(eventi)->>'stato','pubblicato')) NOT IN ('annullato','annullata','bozza','archiviato','scaduto','non_pubblicato')", [action.value]
  );
  return rowCount > 0;
}

export async function runCampaignWorker(dbPool = pool, send = sendPush) {
  const db = await dbPool.connect();
  let locked = false;
  try {
    const lock = await db.query('SELECT pg_try_advisory_lock($1) AS acquired',[LOCK]);
    locked = lock.rows[0].acquired;
    if (!locked) return;
    // An interrupted provider request has an unknown outcome. Never send it twice.
    await db.query(`WITH stale AS (
        UPDATE notification_campaign_recipients SET status='uncertain' WHERE status='sending'
        RETURNING id,attempts
      ) UPDATE notification_campaign_attempts a SET outcome='uncertain',finished_at=now()
        FROM stale s WHERE a.recipient_id=s.id AND a.attempt=s.attempts`);
    if (process.env.NOTIFICATION_CAMPAIGNS_AUTOMATION === '1') await queueAutomaticCampaigns(db);
    const { rows: campaigns } = await db.query(`
      SELECT * FROM notification_campaigns c WHERE status IN ('programmata','in_invio')
      AND scheduled_at<=now()
      AND (status='programmata' OR EXISTS (
        SELECT 1 FROM notification_campaign_recipients r WHERE r.campaign_id=c.id
        GROUP BY r.campaign_id HAVING bool_or(r.status='pending' AND r.next_attempt_at<=now())
          OR NOT bool_or(r.status='pending')
      ))
      ORDER BY scheduled_at,id LIMIT 10`);
    for (const campaign of campaigns) {
      const claimed = await db.query(`UPDATE notification_campaigns SET status='in_invio',updated_at=now()
        WHERE id=$1 AND status IN ('programmata','in_invio')`,[campaign.id]);
      if (!claimed.rowCount) continue;

      if ((!(await eventIsCurrent(db,campaign.action)) || !(await campaignSourceIsCurrent(db,campaign.source)))) {
        await db.query("UPDATE notification_campaign_recipients SET status='excluded' WHERE campaign_id=$1 AND status='pending'",[campaign.id]);
      }
      const { rows } = await db.query(`SELECT id,user_id,token_hash FROM notification_campaign_recipients
        WHERE campaign_id=$1 AND status='pending' AND next_attempt_at<=now()
        ORDER BY id LIMIT 30`,[campaign.id]);
      for (const item of rows) {
        const { rows: [destination] } = await db.query(matchingToken + `
          AND (NOT $3::boolean OR EXISTS (
             SELECT 1 FROM notification_preferences p WHERE p.user_id=u.id AND p.marketing AND (NOT $4::boolean OR p.personalization)
          )) LIMIT 1`,[item.user_id,item.token_hash,campaign.purpose==='marketing' || Boolean(campaign.filters.consentOnly),campaign.purpose==='marketing' && Boolean(campaign.filters.booking || campaign.filters.activity)]);
        if (!destination || (!(await eventIsCurrent(db,campaign.action)) || !(await campaignSourceIsCurrent(db,campaign.source)))) {
          await db.query("UPDATE notification_campaign_recipients SET status='excluded' WHERE id=$1",[item.id]);
          continue;
        }
        const { rows: [attempt] } = await db.query(`WITH claimed AS (
            UPDATE notification_campaign_recipients SET status='sending',attempts=attempts+1
            WHERE id=$1 AND status='pending' RETURNING id,attempts
          ) INSERT INTO notification_campaign_attempts(recipient_id,attempt)
            SELECT id,attempts FROM claimed RETURNING attempt`,[item.id]);
        if (!attempt) continue;
        const result = await sendCampaignPush(campaign,destination.push_token,item.id,send);
        const code = result?.code ?? 'unknown';
        const outcome = result?.success ? 'accepted' : invalidCodes.has(code) ? 'invalid'
          : retryCodes.has(code) && attempt.attempt < 4 ? 'pending'
          : code === 'unknown' || code === 'messaging/server-unavailable' || code === 'messaging/internal-error' ? 'uncertain' : 'failed';
        await db.query(`WITH recorded AS (
            UPDATE notification_campaign_attempts SET outcome=$3,finished_at=now(),provider_message_id=$4,provider_error=$5
            WHERE recipient_id=$1 AND attempt=$2
          ), invalidated AS (
            INSERT INTO notification_invalid_tokens(token_hash) SELECT $6 WHERE $3='invalid'
            ON CONFLICT (token_hash) DO NOTHING
          ) UPDATE notification_campaign_recipients SET status=$3,next_attempt_at=now() + make_interval(mins=>2*attempts)
           WHERE id=$1`,[item.id,attempt.attempt,outcome,result?.id ?? null,result?.success ? null : code,item.token_hash]);
      }

      await db.query(`WITH counts AS (
        SELECT count(*) FILTER (WHERE status IN ('pending','sending')) AS remaining,
          count(*) FILTER (WHERE status='accepted') AS accepted,
          count(*) FILTER (WHERE status<>'accepted') AS other
        FROM notification_campaign_recipients WHERE campaign_id=$1
      ) UPDATE notification_campaigns SET finished_at=now(),updated_at=now(),
        status=CASE WHEN accepted=0 THEN 'fallita' WHEN other>0 THEN 'parziale' ELSE 'completata' END
        FROM counts WHERE id=$1 AND remaining=0 AND status='in_invio'`,[campaign.id]);
    }
  } finally {
    try {
      if (locked) await db.query('SELECT pg_advisory_unlock($1)',[LOCK]);
      db.release();
    } catch (error) {
      db.release(error);
    }
  }
}

export function startCampaignWorker() {
  if (process.env.NOTIFICATION_CAMPAIGNS_WORKER !== '1') return;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runCampaignWorker(); }
    catch (error) { console.error('[CENTRO NOTIFICHE]',error.code ?? error.name); }
    finally { running = false; }
  },15000);
  timer.unref();
}
