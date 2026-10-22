BEGIN;
CREATE TABLE IF NOT EXISTS public.pixel_fermate_test_metadata (
    fermata_id BIGINT PRIMARY KEY REFERENCES public.pixel_fermate(id) ON DELETE CASCADE,
    fonte TEXT NOT NULL CHECK (fonte = 'osm'),
    riferimento_fonte TEXT NOT NULL,
    osm_id TEXT NOT NULL,
    uso TEXT NOT NULL DEFAULT 'collaudo' CHECK (uso = 'collaudo'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pixel_fermate_test_osm
    ON public.pixel_fermate_test_metadata(osm_id);
COMMIT;
-- Attribuzione richiesta nell'interfaccia: © OpenStreetMap contributors — ODbL
-- https://www.openstreetmap.org/copyright
