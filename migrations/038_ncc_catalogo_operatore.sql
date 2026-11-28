BEGIN;
ALTER TABLE public.catalogo_luoghi ADD COLUMN operatore_id integer REFERENCES public.utente(id) ON DELETE CASCADE;
CREATE INDEX catalogo_luoghi_operatore_idx ON public.catalogo_luoghi(operatore_id) WHERE operatore_id IS NOT NULL;
COMMIT;
