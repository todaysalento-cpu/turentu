-- TURENTU | Migrazione additiva richieste A/R vincolate
-- Eseguire in psql, preferibilmente in finestra di manutenzione.
-- Non attiva alcuna logica A/R nel worker.
BEGIN;

ALTER TABLE public.richieste_pop_bus
  ADD COLUMN IF NOT EXISTS ar_group_id uuid,
  ADD COLUMN IF NOT EXISTS ar_tratta varchar(7),
  ADD COLUMN IF NOT EXISTS ar_vincolata boolean DEFAULT false;

-- Mantiene compatibili eventuali righe preesistenti.
UPDATE public.richieste_pop_bus
SET ar_vincolata = false
WHERE ar_vincolata IS NULL;

ALTER TABLE public.richieste_pop_bus
  ALTER COLUMN ar_vincolata SET NOT NULL;

-- Non permettere metadati A/R parziali o inconsistenti.
ALTER TABLE public.richieste_pop_bus
  ADD CONSTRAINT richieste_pop_bus_ar_coerenza_chk
  CHECK (
    (ar_vincolata = false AND ar_group_id IS NULL AND ar_tratta IS NULL)
    OR
    (ar_vincolata = true AND ar_group_id IS NOT NULL AND ar_tratta IN ('andata', 'ritorno'))
  );

-- Ogni gruppo vincolato puo' contenere al massimo una richiesta per tratta.
CREATE UNIQUE INDEX richieste_pop_bus_ar_group_tratta_uq
  ON public.richieste_pop_bus (ar_group_id, ar_tratta)
  WHERE ar_vincolata = true;

COMMIT;

-- Verifiche in sola lettura: le righe ordinarie devono rimanere ordinarie.
SELECT COUNT(*) AS totale,
       COUNT(*) FILTER (WHERE ar_vincolata) AS ar_vincolate,
       COUNT(*) FILTER (WHERE NOT ar_vincolata) AS ordinarie
FROM public.richieste_pop_bus;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='richieste_pop_bus'
  AND column_name IN ('ar_group_id','ar_tratta','ar_vincolata')
ORDER BY column_name;
