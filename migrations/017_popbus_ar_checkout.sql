BEGIN;
ALTER TABLE public.ar_gruppi
  ADD COLUMN IF NOT EXISTS andata_tipo varchar(16),
  ADD COLUMN IF NOT EXISTS ritorno_tipo varchar(16),
  ADD COLUMN IF NOT EXISTS prezzo_andata_cents integer,
  ADD COLUMN IF NOT EXISTS prezzo_ritorno_cents integer,
  ADD COLUMN IF NOT EXISTS payment_intent_andata varchar(255),
  ADD COLUMN IF NOT EXISTS payment_intent_ritorno varchar(255),
  ADD COLUMN IF NOT EXISTS popbus_checkout jsonb;
COMMIT;
