BEGIN;
ALTER TABLE public.ncc_prenotazioni_esterne ADD COLUMN import_hash text;
CREATE UNIQUE INDEX ncc_import_identita ON public.ncc_prenotazioni_esterne
  (operatore_id, import_hash) WHERE import_hash IS NOT NULL;
CREATE TABLE public.ncc_gruppi_approvati (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operatore_id integer NOT NULL REFERENCES public.utente(id) ON DELETE CASCADE,
  prenotazioni bigint[] NOT NULL,
  approvato_il timestamptz NOT NULL DEFAULT now()
);
COMMIT;
