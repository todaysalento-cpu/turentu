// The token digest protects tokens in the campaign and audit tables.
const tokenHash = "encode(sha256(convert_to(t.push_token,'UTF8')),'hex')";

export function audienceQuery(filters, purpose, scope = {}) {
  const params = [];
  const arg = value => { params.push(value); return '$' + params.length; };
  const conditions = ['u.eliminato_il IS NULL'];
  if (filters.contactId) conditions.push('u.id=' + arg(filters.contactId) + '::bigint');
  if (scope.userId) conditions.push('u.id=' + arg(scope.userId) + '::bigint');
  if (scope.excludeRideId) conditions.push('NOT EXISTS (SELECT 1 FROM prenotazioni p0 WHERE p0.cliente_id=u.id AND p0.corsa_id=' + arg(scope.excludeRideId) + '::bigint)');
  if (filters.role === 'conducente') {
    conditions.push("EXISTS (SELECT 1 FROM conducenti_operatori co WHERE co.conducente_id=u.id AND co.stato='attivo')");
  } else if (filters.role) {
    conditions.push("lower(btrim(u.tipo))=" + arg(filters.role));
  }
  if (filters.newDays) conditions.push("u.created_at >= now()-make_interval(days=>" + arg(filters.newDays) + "::int)");
  if ((filters.booking || filters.activity) && purpose === 'marketing') conditions.push('p.personalization IS TRUE');
  if (filters.booking === 'ever') conditions.push('EXISTS (SELECT 1 FROM prenotazioni b WHERE b.cliente_id=u.id)');
  if (filters.booking === 'popbus') conditions.push('EXISTS (SELECT 1 FROM richieste_pop_bus b WHERE b.cliente_id=u.id)');
  if (filters.activity) {
    conditions.push((filters.activity==='inactive'?'NOT ':'') + `EXISTS (
      SELECT 1 FROM prenotazioni b JOIN corse c ON c.id=b.corsa_id
      WHERE b.cliente_id=u.id AND c.start_datetime >= now()-interval '90 days'
      UNION ALL SELECT 1 FROM richieste_pop_bus b WHERE b.cliente_id=u.id
        AND b.start_datetime>=now()-interval '90 days')`);
  }
  if (filters.booking === 'no_recent') {
    conditions.push("NOT EXISTS (SELECT 1 FROM prenotazioni b JOIN corse c ON c.id=b.corsa_id WHERE b.cliente_id=u.id AND c.start_datetime >= now()-interval '90 days')");
  }
  for (const [field, key] of [['region','region'], ['province','province'], ['city','city'], ['origin','origin'], ['destination','destination']]) {
    if (filters[field]?.length) conditions.push("lower(p.territory->>'" + key + "')=ANY(" + arg(filters[field].map(s => s.toLowerCase())) + "::text[])");
  }
  for (const key of ['hub','stop','directive']) {
    if (filters[key]) conditions.push("p.territory->>'" + key + "'=" + arg(filters[key]));
  }
  if (filters.interests?.length) conditions.push('p.interests && ' + arg(filters.interests) + '::text[]');
  if (filters.radius) {
    const { lat, lng, km } = filters.radius;
    conditions.push(`ST_DWithin(
      (SELECT n.posizione::geography FROM public.nodi_territoriali n
        WHERE n.attivo AND n.id::text=p.territory->>'hub'),
      ST_SetSRID(ST_MakePoint(${arg(lng)},${arg(lat)}),4326)::geography,${arg(km * 1000)})`);
  }

  const requireConsent = purpose === 'marketing' || filters.consentOnly;
  return {
    params,
    cte: `WITH selected AS (
      SELECT u.id AS user_id, ${requireConsent ? 'coalesce(p.marketing,false)' : 'true'} AS consent
      FROM utente u LEFT JOIN notification_preferences p ON p.user_id=u.id
      WHERE ${conditions.join(' AND ')}
    ), candidates AS (
      SELECT s.user_id, ${tokenHash} AS token_hash,
        row_number() OVER (PARTITION BY t.push_token ORDER BY s.user_id) AS duplicate
      FROM selected s JOIN utente_push_tokens t ON t.user_id=s.user_id
      WHERE s.consent AND t.push_token ~ '^[A-Za-z0-9_:-]{40,}$'
        AND NOT EXISTS (SELECT 1 FROM notification_invalid_tokens i WHERE i.token_hash=${tokenHash})
        AND NOT EXISTS (SELECT 1 FROM utente_push_tokens other WHERE other.push_token=t.push_token AND other.user_id<>s.user_id)
    )`,
  };
}

export async function previewAudience(db, filters, purpose) {
  const { cte, params } = audienceQuery(filters, purpose);
  const { rows: [counts] } = await db.query(`${cte}
    SELECT (SELECT count(*)::int FROM selected) AS selected,
      (SELECT count(DISTINCT user_id)::int FROM candidates) AS reachable,
      (SELECT count(*)::int FROM selected WHERE NOT consent) AS no_consent,
      (SELECT count(*)::int FROM selected s WHERE consent AND NOT EXISTS
        (SELECT 1 FROM candidates c WHERE c.user_id=s.user_id)) AS no_token,
      (SELECT count(*)::int FROM candidates WHERE duplicate=1) AS tokens,
      (SELECT count(*)::int FROM candidates WHERE duplicate>1) AS duplicates,
      (SELECT encode(sha256(convert_to(coalesce(string_agg(user_id::text||':'||token_hash,',' ORDER BY token_hash),''),'UTF8')),'hex')
        FROM candidates WHERE duplicate=1) AS fingerprint`, params);
  return counts;
}

export async function materializeAudience(db, campaign) {
  const { cte, params } = audienceQuery(campaign.filters, campaign.purpose, campaign.source ?? {});
  await db.query(`${cte}
    INSERT INTO notification_campaign_recipients (campaign_id,user_id,token_hash)
    SELECT $${params.length + 1},user_id,token_hash FROM candidates WHERE duplicate=1
    ON CONFLICT (campaign_id,token_hash) DO NOTHING`, [...params,campaign.id]);
}
