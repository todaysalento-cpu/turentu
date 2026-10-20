-- TURENTU | PIXEL -> POPBUS | MIGRAZIONE REALE
-- NON ESEGUIRE prima del preflight e della verifica delle dipendenze applicative.
-- Eseguire solo in finestra controllata e con backup/snapshot verificato.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.popbus_attivazioni ALTER COLUMN direttrice_id DROP NOT NULL;
ALTER TABLE public.popbus_attivazione_missioni ADD COLUMN IF NOT EXISTS pixel_opportunita_id bigint;
ALTER TABLE public.popbus_attivazione_missioni
 ADD CONSTRAINT fk_popbus_missione_pixel_opportunita
 FOREIGN KEY (pixel_opportunita_id) REFERENCES public.pixel_opportunita(id);
CREATE INDEX IF NOT EXISTS idx_popbus_missione_pixel_opportunita
 ON public.popbus_attivazione_missioni(pixel_opportunita_id);
COMMIT;
