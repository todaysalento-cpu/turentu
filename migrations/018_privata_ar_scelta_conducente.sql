ALTER TABLE public.ar_accettazioni
  ADD COLUMN IF NOT EXISTS scelta_conducente jsonb;
