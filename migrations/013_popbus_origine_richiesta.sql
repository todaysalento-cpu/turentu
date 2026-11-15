ALTER TABLE public.richieste_pop_bus
    ADD COLUMN IF NOT EXISTS origine_richiesta jsonb;
