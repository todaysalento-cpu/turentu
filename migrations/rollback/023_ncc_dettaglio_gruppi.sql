BEGIN;
DROP TABLE public.ncc_parametri_pianificatore;
ALTER TABLE public.ncc_gruppi_approvati DROP COLUMN dettaglio;
COMMIT;
