BEGIN;
ALTER TABLE public.procaccio_operatori ADD COLUMN IF NOT EXISTS piattaforma_app TEXT
  CHECK (piattaforma_app IN ('android', 'ios'));
ALTER TABLE public.procaccio_operatori ADD COLUMN IF NOT EXISTS fascia_contatto TEXT
  CHECK (fascia_contatto IN ('mattina', 'pomeriggio'));
COMMIT;
