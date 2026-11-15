CREATE TABLE IF NOT EXISTS public.pixel_candidati_google (
    nodo_territoriale_id bigint NOT NULL REFERENCES public.nodi_territoriali(id) ON DELETE CASCADE,
    place_id text NOT NULL CHECK (length(place_id) > 0),
    rilevato_il timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (nodo_territoriale_id, place_id)
);
