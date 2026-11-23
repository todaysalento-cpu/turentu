BEGIN;
ALTER TABLE public.ncc_gruppi_approvati ADD COLUMN dettaglio jsonb;
CREATE TABLE public.ncc_parametri_pianificatore (
  operatore_id integer PRIMARY KEY REFERENCES public.utente(id) ON DELETE CASCADE,
  tolleranza_minuti integer NOT NULL CHECK (tolleranza_minuti BETWEEN 0 AND 1440),
  obiettivo_riempimento integer NOT NULL CHECK (obiettivo_riempimento BETWEEN 0 AND 100),
  priorita_volo boolean NOT NULL
);
COMMIT;
