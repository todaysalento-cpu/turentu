-- TURENTU A/R STEP 3 - eseguire SOLO in ambiente di test.
-- Non abilita prenotazioni o catture. Stato A/R separato dalle singole tratte.
BEGIN;
CREATE TABLE IF NOT EXISTS public.ar_gruppi (
  id uuid PRIMARY KEY,
  cliente_id bigint NOT NULL REFERENCES public.utente(id),
  stato varchar(32) NOT NULL DEFAULT 'preparazione',
  andata_tipo varchar(16) NOT NULL,
  ritorno_tipo varchar(16) NOT NULL,
  prezzo_andata_cents integer NOT NULL CHECK (prezzo_andata_cents >= 50),
  prezzo_ritorno_cents integer NOT NULL CHECK (prezzo_ritorno_cents >= 50),
  payment_intent_andata varchar(255),
  payment_intent_ritorno varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT ar_gruppi_stato_check CHECK (stato IN
    ('preparazione','in_autorizzazione','autorizzato','in_attesa','pronto','confermato','annullamento_richiesto','annullato','scaduto','errore')),
  CONSTRAINT ar_gruppi_tipi_check CHECK (andata_tipo IN ('privata','condivisa','popbus') AND ritorno_tipo IN ('privata','condivisa','popbus')),
  CONSTRAINT ar_gruppi_distinct_pi CHECK (payment_intent_andata IS NULL OR payment_intent_ritorno IS NULL OR payment_intent_andata <> payment_intent_ritorno)
);
CREATE UNIQUE INDEX IF NOT EXISTS ar_gruppi_pi_andata_unique ON public.ar_gruppi(payment_intent_andata) WHERE payment_intent_andata IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ar_gruppi_pi_ritorno_unique ON public.ar_gruppi(payment_intent_ritorno) WHERE payment_intent_ritorno IS NOT NULL;
CREATE INDEX IF NOT EXISTS ar_gruppi_cliente_stato_idx ON public.ar_gruppi(cliente_id, stato);
CREATE INDEX IF NOT EXISTS ar_gruppi_scadenza_idx ON public.ar_gruppi(expires_at) WHERE stato NOT IN ('confermato','annullato','scaduto');
COMMIT;
