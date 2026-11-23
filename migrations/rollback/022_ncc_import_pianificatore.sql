BEGIN;
DROP TABLE public.ncc_gruppi_approvati;
ALTER TABLE public.ncc_prenotazioni_esterne DROP COLUMN import_hash;
COMMIT;
