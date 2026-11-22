import { materializeAudience } from './campaign-audience.service.js';

export const ruleKinds = ['event_published','event_tomorrow','event_weekend','popbus_opportunity','popbus_activated','popbus_deadline'];

export const maxSourceId = {
  event_published: 'SELECT coalesce(max(id),0) AS id FROM public.eventi',
  event_tomorrow: 'SELECT 0 AS id',
  event_weekend: 'SELECT 0 AS id',
  popbus_activated: 'SELECT coalesce(max(id),0) AS id FROM public.popbus_attivazioni WHERE stato=\'confermata\'',
  popbus_deadline: 'SELECT 0 AS id',
  popbus_opportunity: 'SELECT coalesce(max(id),0) AS id FROM public.pixel_opportunita',
};
const eventPublic = "lower(coalesce(to_jsonb(eventi)->>'stato','pubblicato')) NOT IN ('annullato','annullata','bozza','archiviato','scaduto','non_pubblicato')";
const candidates = {
  event_published: `SELECT id::text AS key,titolo,citta,luogo_nome,immagine_url
    FROM public.eventi WHERE id>$1 AND data_inizio>now() AND ${eventPublic}`,
  event_tomorrow: `SELECT id::text AS key,titolo,citta,luogo_nome,immagine_url
    FROM public.eventi WHERE id>$1 AND timezone('Europe/Rome',data_inizio)::date=timezone('Europe/Rome',now())::date+1 AND ${eventPublic}`,
  event_weekend: `SELECT id::text AS key,titolo,citta,luogo_nome,immagine_url FROM public.eventi
    WHERE id>$1 AND data_inizio>now() AND ${eventPublic}
    AND timezone('Europe/Rome',data_inizio)::date BETWEEN
      date_trunc('week',timezone('Europe/Rome',now()))::date+5 AND date_trunc('week',timezone('Europe/Rome',now()))::date+6`,
  popbus_activated: `SELECT a.id::text AS key,a.direttrice_id::text AS directive,a.corsa_id::text AS ride
    FROM public.popbus_attivazioni a WHERE a.id>$1 AND a.stato='confermata' AND a.corsa_id IS NOT NULL AND a.partenza>now()`,
  popbus_deadline: `SELECT id::text AS key,cliente_id::text AS user_id,conferma_entro
    FROM public.richieste_pop_bus WHERE id>$1 AND stato='in_attesa' AND corsa_id IS NULL
      AND conferma_entro>now() AND conferma_entro<=now()+interval '3 hours'`,
  popbus_opportunity: `SELECT o.id::text AS key,o.direttrice_id::text AS directive
    FROM public.pixel_opportunita o JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
    WHERE o.id>$1 AND o.stato='candidata' AND d.stato='attiva' AND o.inizio_finestra>now()`,
};
const notifications = {
  event_published: row => ({ category:'Eventi', title:row.titolo,
    body:[row.citta,row.luogo_nome].filter(Boolean).join(' · ') || 'Scopri l’evento su Turentu.',
    action:{kind:'event',value:row.key}, image:row.immagine_url, interest:'eventi', city:row.citta }),
  event_tomorrow: row => ({ category:'Eventi', title:'Domani: ' + row.titolo,
    body:[row.citta,row.luogo_nome].filter(Boolean).join(' · ') || 'Scopri l’evento su Turentu.',
    action:{kind:'event',value:row.key}, image:row.immagine_url, interest:'eventi', city:row.citta }),
  event_weekend: row => ({category:'Eventi',title:'Questo fine settimana: ' + row.titolo,
    body:[row.citta,row.luogo_nome].filter(Boolean).join(' · ') || 'Scopri l’evento su Turentu.',
    action:{kind:'event',value:row.key},image:row.immagine_url,interest:'eventi',city:row.citta}),
  popbus_activated: row => ({category:'PopBus',title:'PopBus attivato',
    body:'Apri la ricerca PopBus per verificare le corse disponibili sulla tua direttrice.',
    action:{kind:'popbus'},interest:'popbus',directive:row.directive,excludeRideId:row.ride}),
  popbus_deadline: row => ({category:'Comunicazioni di servizio',title:'Richiesta PopBus in scadenza',
    body:'Il termine per la conferma è il ' + new Intl.DateTimeFormat('it-IT',{
      dateStyle:'short',timeStyle:'short',timeZone:'Europe/Rome'}).format(new Date(row.conferma_entro)) + '. Apri Turentu per controllare la richiesta.',
    action:{kind:'home'},purpose:'operativa',userId:row.user_id}),
  popbus_opportunity: row => ({ category:'PopBus', title:'Nuova opportunità PopBus',
    body:'Cerca la tratta su Turentu. La corsa si attiva al raggiungimento della soglia.',
    action:{kind:'popbus'}, interest:'popbus', directive:row.directive }),
};
export function ruleDraft(kind,row,rule) {
  const info = notifications[kind](row);
  const slug = info.directive ?? info.city?.trim();
  if (!slug && !info.userId) return null;
  // Preserve explicit segment constraints by intersection, then require the matching declared interest.
  if (info.directive && rule.filters.directive && rule.filters.directive !== info.directive) return null;
  if (info.city && rule.filters.destination?.length &&
      !rule.filters.destination.some(v=>v.toLowerCase()===info.city.toLowerCase())) return null;
  if (info.interest && rule.filters.interests?.length && !rule.filters.interests.includes(info.interest)) return null;
  return {
    ...info,
    title:Array.from(info.title).slice(0,65).join(''),
    body:Array.from(info.body).slice(0,220).join(''),
    filters:{...rule.filters,...(info.interest?{interests:[info.interest]}:{}),
      ...(info.directive ? {directive:info.directive} : info.city ? {destination:[info.city]} : {}) },
  };
}
export async function queueAutomaticCampaigns(db) {
  const {rows:rules} = await db.query(`SELECT r.id,r.kind,r.created_by,r.start_after,s.filters
    FROM notification_campaign_rules r JOIN notification_segments s ON s.id=r.segment_id WHERE r.enabled ORDER BY r.id`);
  for (const rule of rules) {
    const interest=rule.kind==='popbus_deadline' ? null : rule.kind.startsWith('popbus_') ? 'popbus' : 'eventi';
    if (interest && rule.filters.interests?.length && !rule.filters.interests.includes(interest)) continue;
    const {rows} = await db.query(`SELECT src.* FROM (${candidates[rule.kind]}) src
      WHERE NOT EXISTS (SELECT 1 FROM notification_campaign_rule_runs h WHERE h.kind=$2 AND h.source_key=src.key)
      AND ($3::text IS NULL OR to_jsonb(src)->>'directive' IS NULL OR to_jsonb(src)->>'directive'=$3)
      AND ($4::text[] IS NULL OR to_jsonb(src)->>'citta' IS NULL OR lower(to_jsonb(src)->>'citta')=ANY($4))
      ORDER BY src.key::bigint LIMIT 15`,[rule.start_after,rule.kind,rule.filters.directive ?? null,rule.filters.destination?.length ? rule.filters.destination.map(v=>v.toLowerCase()) : null]);
    for (const row of rows) {
      const value = ruleDraft(rule.kind,row,rule);
      if (!value) continue;
      try {
        await db.query('BEGIN');
        const {rowCount} = await db.query(`INSERT INTO notification_campaign_rule_runs(kind,source_key,rule_id)
          SELECT kind,$2,id FROM notification_campaign_rules WHERE id=$1 AND enabled
          ON CONFLICT (kind,source_key) DO NOTHING`,[rule.id,row.key]);
        if (rowCount) {
          const {rows:[campaign]} = await db.query(`INSERT INTO notification_campaigns
            (name,category,title,body,image_url,purpose,action,filters,priority,status,scheduled_at,created_by,source)
            VALUES ($1,$2,$3,$4,$5,$10,$6,$7,'normal','in_preparazione',now(),$8,$9) RETURNING *`,
          [value.title,value.category,value.title,value.body,value.image?.startsWith('https://')?value.image:null,
            value.action,value.filters,rule.created_by,{kind:rule.kind,id:row.key,ruleId:rule.id,userId:value.userId,excludeRideId:value.excludeRideId},value.purpose??'marketing']);
          await materializeAudience(db,campaign);
          const {rows:[size]} = await db.query('SELECT count(*)::int AS tokens FROM notification_campaign_recipients WHERE campaign_id=$1',[campaign.id]);
          await db.query(`UPDATE notification_campaigns SET status=CASE WHEN $2::int BETWEEN 1 AND 500 THEN 'programmata' ELSE 'annullata' END,
            finished_at=CASE WHEN $2::int BETWEEN 1 AND 500 THEN NULL ELSE now() END WHERE id=$1`,[campaign.id,size.tokens]);
          await db.query(`INSERT INTO notification_campaign_audit(actor_id,campaign_id,operation,details)
            VALUES ($1,$2,'automatic_prepare',$3)`,[rule.created_by,campaign.id,{rule:rule.id,tokens:size.tokens}]);
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
  }
}

export async function campaignSourceIsCurrent(db,source) {
  if (!source) return true;
  const enabled=await db.query('SELECT 1 FROM notification_campaign_rules WHERE id=$1 AND enabled',[source.ruleId]);
  if (!enabled.rowCount) return false;
  if (source.kind==='popbus_deadline') {
    return (await db.query("SELECT 1 FROM public.richieste_pop_bus WHERE id=$1 AND stato='in_attesa' AND corsa_id IS NULL AND conferma_entro>now()",[source.id])).rowCount>0;
  }
  if (source.kind==='popbus_activated') {
    return (await db.query("SELECT 1 FROM public.popbus_attivazioni WHERE id=$1 AND stato='confermata' AND corsa_id IS NOT NULL AND partenza>now()",[source.id])).rowCount>0;
  }
  if (source.kind !== 'popbus_opportunity') return true;
  const {rowCount} = await db.query(`SELECT 1 FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
    WHERE o.id=$1 AND o.stato='candidata' AND d.stato='attiva' AND o.inizio_finestra>now()`,[source.id]);
  return rowCount>0;
}
