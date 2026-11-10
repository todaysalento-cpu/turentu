BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.event_discovery_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  config jsonb NOT NULL
);
INSERT INTO public.event_discovery_settings (config) VALUES
  ('{"territories":["Salento","Lecce","Brindisi","Taranto","Bari"],"categories":["concerti","sport","festival","sagre","feste patronali","fiere","cultura","mostre"],"highPriority":["concerti","sport","festival"],"mediumPriority":["sagre","feste patronali","fiere","cultura"],"days":90,"intervalMinutes":1440,"radiusKm":10,"autoPublishConfidence":90}');

CREATE TABLE public.event_discovery_sources (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL UNIQUE,
  domain text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('jsonld','html','json','ics','rss','social')),
  state text NOT NULL DEFAULT 'candidata' CHECK (state IN ('candidata','in_verifica','attiva','sospesa','non_supportata')),
  terms text,
  timezone text NOT NULL DEFAULT 'Europe/Rome',
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes BETWEEN 15 AND 43200),
  reliability integer NOT NULL DEFAULT 50 CHECK (reliability BETWEEN 0 AND 100),
  last_sync timestamptz,
  last_full_sync timestamptz,
  last_result text,
  last_count integer,
  etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'attiva' OR (kind <> 'social' AND length(trim(terms)) > 0 AND terms IS NOT NULL))
);
CREATE INDEX event_discovery_due ON public.event_discovery_sources (last_sync, id) WHERE state = 'attiva';

CREATE TABLE public.event_discovery_candidates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id integer NOT NULL REFERENCES public.event_discovery_sources,
  external_key text NOT NULL,
  data jsonb NOT NULL,
  reviewed_data jsonb,
  published_data jsonb,
  evidence jsonb NOT NULL,
  fingerprint text NOT NULL,
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','published')),
  event_id integer REFERENCES public.eventi ON DELETE SET NULL,
  auto_publish boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_key)
);
CREATE INDEX event_discovery_fingerprint ON public.event_discovery_candidates (fingerprint);
CREATE INDEX event_discovery_review ON public.event_discovery_candidates (state, observed_at DESC);
CREATE INDEX event_discovery_canonical ON public.event_discovery_candidates
  ((published_data->>'url'), (published_data->>'start')) WHERE event_id IS NOT NULL;

CREATE TABLE public.event_discovery_runs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id integer REFERENCES public.event_discovery_sources,
  kind text NOT NULL CHECK (kind IN ('search','sync')),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','success','error')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  count integer,
  error text
);
CREATE INDEX event_discovery_runs_recent ON public.event_discovery_runs (kind, started_at DESC);

CREATE TABLE public.event_discovery_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id integer,
  action text NOT NULL,
  entity_id integer,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_discovery_audit_entity ON public.event_discovery_audit (entity_id, created_at DESC);

CREATE TABLE public.event_discovery_territory (
  event_id integer PRIMARY KEY REFERENCES public.eventi ON DELETE CASCADE,
  node_id bigint NOT NULL REFERENCES public.nodi_territoriali ON DELETE CASCADE,
  stop_id bigint REFERENCES public.pixel_fermate ON DELETE SET NULL
);

COMMIT;
