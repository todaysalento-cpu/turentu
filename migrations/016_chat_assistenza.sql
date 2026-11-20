BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_assistenza_messaggi (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utente_id INTEGER NOT NULL REFERENCES public.utente(id) ON DELETE CASCADE,
  da_assistenza BOOLEAN NOT NULL,
  richiesta_id UUID NOT NULL UNIQUE,
  testo TEXT NOT NULL CHECK (char_length(btrim(testo)) BETWEEN 1 AND 2000),
  inviato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_assistenza_utente_id_idx
  ON public.chat_assistenza_messaggi (utente_id, id DESC);

COMMIT;
