BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_eliminazioni_utenti (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  utente_id INTEGER NOT NULL,
  esito TEXT NOT NULL CHECK (esito IN ('eliminato', 'bloccato')),
  dipendenze TEXT[] NOT NULL DEFAULT '{}',
  creato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
