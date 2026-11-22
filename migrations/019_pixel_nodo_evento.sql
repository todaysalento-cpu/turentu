BEGIN;

ALTER TABLE public.nodi_territoriali
  ADD COLUMN IF NOT EXISTS evento_id bigint
  REFERENCES public.eventi(id);

CREATE UNIQUE INDEX IF NOT EXISTS nodi_territoriali_evento_id_uidx
  ON public.nodi_territoriali (evento_id)
  WHERE evento_id IS NOT NULL;

COMMIT;
