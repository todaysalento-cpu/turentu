-- TURENTU | PIXEL -> POPBUS | PRE-FLIGHT DDL IN ROLLBACK
-- Eseguire con psql -X -v ON_ERROR_STOP=1 -f 01_pixel_popbus_preflight_rollback.sql
-- NON lascia modifiche persistenti. Richiede permessi ALTER sulle tabelle.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
SELECT 'PRE' AS fase, table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema='public' AND (
 (table_name='popbus_attivazioni' AND column_name='direttrice_id') OR
 (table_name='popbus_attivazione_missioni' AND column_name='pixel_opportunita_id'))
ORDER BY table_name, column_name;
-- Simulazione ESATTA della modifica proposta, entro la transazione.
ALTER TABLE public.popbus_attivazioni ALTER COLUMN direttrice_id DROP NOT NULL;
ALTER TABLE public.popbus_attivazione_missioni ADD COLUMN IF NOT EXISTS pixel_opportunita_id bigint;
-- Se il nome esiste, il preflight fallisce intenzionalmente: ispezionare prima.
ALTER TABLE public.popbus_attivazione_missioni
 ADD CONSTRAINT fk_popbus_missione_pixel_opportunita
 FOREIGN KEY (pixel_opportunita_id) REFERENCES public.pixel_opportunita(id);
CREATE INDEX IF NOT EXISTS idx_popbus_missione_pixel_opportunita
 ON public.popbus_attivazione_missioni(pixel_opportunita_id);
SELECT 'DURANTE_TRANSAZIONE' AS fase, table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema='public' AND (
 (table_name='popbus_attivazioni' AND column_name='direttrice_id') OR
 (table_name='popbus_attivazione_missioni' AND column_name='pixel_opportunita_id'))
ORDER BY table_name, column_name;
ROLLBACK;
\echo 'PRE-FLIGHT COMPLETATO: ROLLBACK eseguito, nessuna modifica persistente.'
