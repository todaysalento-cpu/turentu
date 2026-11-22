BEGIN;
CREATE TABLE notification_preferences (
  user_id bigint PRIMARY KEY,
  marketing boolean NOT NULL DEFAULT false,
  personalization boolean NOT NULL DEFAULT false,
  territory jsonb NOT NULL DEFAULT '{}'::jsonb,
  interests text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_segments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  filters jsonb NOT NULL,
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_media (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL UNIQUE,
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_campaigns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  image_url text,
  purpose text NOT NULL CHECK (purpose IN ('operativa', 'marketing')),
  action jsonb NOT NULL,
  filters jsonb NOT NULL,
  source jsonb,
  priority text NOT NULL CHECK (priority IN ('normal', 'high')),
  status text NOT NULL DEFAULT 'bozza' CHECK (status IN ('bozza','programmata','in_preparazione','in_invio','completata','parziale','fallita','annullata')),
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scheduled_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX notification_campaigns_due ON notification_campaigns (scheduled_at,id)
WHERE status IN ('programmata','in_preparazione','in_invio');
CREATE TABLE notification_campaign_recipients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES notification_campaigns ON DELETE CASCADE,
  user_id bigint NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','accepted','invalid','failed','excluded','uncertain')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  clicked_at timestamptz,
  UNIQUE (campaign_id,token_hash)
);
CREATE INDEX notification_recipients_ready ON notification_campaign_recipients (campaign_id,next_attempt_at,id) WHERE status='pending';
CREATE TABLE notification_campaign_attempts (
  recipient_id bigint NOT NULL REFERENCES notification_campaign_recipients ON DELETE CASCADE,
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  provider_message_id text,
  provider_error text,
  PRIMARY KEY (recipient_id,attempt)
);
CREATE TABLE notification_invalid_tokens (
  token_hash text PRIMARY KEY,
  invalidated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_campaign_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id bigint,
  campaign_id bigint REFERENCES notification_campaigns ON DELETE SET NULL,
  operation text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_campaign_audit_campaign ON notification_campaign_audit (campaign_id,created_at);
CREATE TABLE notification_campaign_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('event_published','event_tomorrow','event_weekend','popbus_opportunity','popbus_activated','popbus_deadline')),
  segment_id bigint NOT NULL REFERENCES notification_segments,
  enabled boolean NOT NULL DEFAULT false,
  start_after bigint NOT NULL DEFAULT 0,
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notification_campaign_rules_active ON notification_campaign_rules (kind) WHERE enabled;
CREATE TABLE notification_campaign_rule_runs (
  kind text NOT NULL,
  source_key text NOT NULL,
  rule_id bigint NOT NULL REFERENCES notification_campaign_rules,
  PRIMARY KEY (kind,source_key)
);
COMMIT;
