BEGIN;

ALTER TABLE public.utente ADD COLUMN IF NOT EXISTS eliminato_il TIMESTAMPTZ;

ALTER TABLE public.admin_eliminazioni_utenti
  DROP CONSTRAINT IF EXISTS admin_eliminazioni_utenti_esito_check;
ALTER TABLE public.admin_eliminazioni_utenti
  ADD CONSTRAINT admin_eliminazioni_utenti_esito_check
  CHECK (esito IN ('eliminato', 'bloccato', 'anonimizzato'));

CREATE TABLE IF NOT EXISTS public.admin_rimozioni_file_utenti (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utente_id INTEGER NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'file' CHECK (tipo IN ('file', 'veicolo', 'disponibilita')),
  risorsa_id INTEGER,
  url TEXT,
  stato TEXT NOT NULL DEFAULT 'pending' CHECK (stato IN ('pending', 'processing', 'eliminato', 'manuale')),
  tentativi INTEGER NOT NULL DEFAULT 0,
  prossimo_tentativo_il TIMESTAMPTZ NOT NULL DEFAULT now(),
  creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
  aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (utente_id, url),
  UNIQUE (utente_id, tipo, risorsa_id)
);
CREATE INDEX IF NOT EXISTS admin_rimozioni_file_pending_idx
  ON public.admin_rimozioni_file_utenti (prossimo_tentativo_il)
  WHERE stato IN ('pending', 'processing');

-- Impedisce a richieste già avviate di ripristinare dati personali dopo la chiusura.
CREATE OR REPLACE FUNCTION public.proteggi_account_eliminato()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  campo TEXT;
  valore TEXT;
  eliminato TIMESTAMPTZ;
BEGIN
  IF current_setting('turentu.anonimizzazione', true) = 'on' THEN
    RETURN NEW;
  END IF;
  FOREACH campo IN ARRAY TG_ARGV LOOP
    valore := to_jsonb(NEW) ->> campo;
    IF valore IS NOT NULL AND valore ~ '^[0-9]{1,10}$' AND valore::bigint <= 2147483647 THEN
      SELECT eliminato_il INTO eliminato FROM public.utente WHERE id = valore::integer FOR KEY SHARE;
      IF eliminato IS NOT NULL THEN
        RAISE EXCEPTION 'Account eliminato' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.impedisci_riattivazione_account_eliminato()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.eliminato_il IS NOT NULL THEN
    RAISE EXCEPTION 'Account eliminato' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS proteggi_account_eliminato ON public.utente;
CREATE TRIGGER proteggi_account_eliminato BEFORE UPDATE ON public.utente
  FOR EACH ROW EXECUTE FUNCTION public.impedisci_riattivazione_account_eliminato();

DO $$
DECLARE
  relazione TEXT;
  colonne TEXT;
BEGIN
  FOR relazione, colonne IN SELECT * FROM (VALUES
    ('autista_profilo', '''utente_id'''),
    ('documenti_autista', '''autista_id'''),
    ('veicolo', '''driver_id'''),
    ('utente_push_tokens', '''user_id'''),
    ('password_reset_codes', '''user_id'''),
    ('verifiche_email_utente', '''utente_id'''),
    ('notifications', '''user_id'''),
    ('flow_events', '''user_id'''),
    ('anagrafica_conducenti', '''utente_id'''),
    ('messaggi', '''sender_id'', ''cliente_id'''),
    ('chat_threads', '''cliente_id'', ''driver_id''')
  ) AS t(relazione, colonne) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS proteggi_account_eliminato ON public.%I', relazione);
    EXECUTE format('CREATE TRIGGER proteggi_account_eliminato BEFORE INSERT OR UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.proteggi_account_eliminato(%s)', relazione, colonne);
  END LOOP;
END;
$$;

COMMIT;
