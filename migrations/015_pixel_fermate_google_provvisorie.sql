ALTER TABLE public.pixel_fermate
    ADD COLUMN google_place_id text,
    ADD COLUMN google_geo_scade_il timestamptz,
    ALTER COLUMN posizione DROP NOT NULL,
    ADD CONSTRAINT pixel_fermate_geometria_provvisoria CHECK (
        (google_place_id IS NULL AND google_geo_scade_il IS NULL AND posizione IS NOT NULL)
        OR (google_place_id IS NOT NULL AND NOT verificata AND (
            (posizione IS NOT NULL AND google_geo_scade_il IS NOT NULL)
            OR (posizione IS NULL AND google_geo_scade_il IS NULL AND NOT attiva)
        ))
    );

CREATE UNIQUE INDEX pixel_fermate_google_place_unico
    ON public.pixel_fermate (nodo_territoriale_id, google_place_id) WHERE google_place_id IS NOT NULL;

ALTER TABLE public.popbus_attivazioni ADD COLUMN google_geo_scade_il timestamptz;
ALTER TABLE public.corse ADD COLUMN google_geo_scade_il timestamptz;

CREATE INDEX popbus_attivazioni_google_geo_scadenza
    ON public.popbus_attivazioni (google_geo_scade_il) WHERE google_geo_scade_il IS NOT NULL;

CREATE FUNCTION public.elimina_geometrie_google_popbus() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    ciclo record;
BEGIN
    FOR ciclo IN
        SELECT id, corsa_id FROM public.popbus_attivazioni
        WHERE google_geo_scade_il <= clock_timestamp()
        ORDER BY id FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE public.popbus_attivazione_missioni
        SET piano = piano - 'legs' WHERE attivazione_id = ciclo.id;

        IF ciclo.corsa_id IS NOT NULL THEN
            UPDATE public.prenotazioni
            SET lat_salita = NULL, lon_salita = NULL, lat_discesa = NULL, lon_discesa = NULL
            WHERE corsa_id = ciclo.corsa_id;

            UPDATE public.corse
            SET origine = NULL, destinazione = NULL, percorso_polyline = NULL,
                fermate_pianificate = (
                    SELECT jsonb_agg(f.valore - 'lat' - 'lon' ORDER BY f.ordine)
                    FROM jsonb_array_elements(fermate_pianificate) WITH ORDINALITY AS f(valore, ordine)
                )
            WHERE id = ciclo.corsa_id;
        END IF;

        UPDATE public.popbus_attivazioni
        SET piano = piano - ARRAY['coordinates', 'legs', 'approach', 'returnTrip'],
            google_geo_scade_il = NULL
        WHERE id = ciclo.id;
    END LOOP;

    UPDATE public.pixel_fermate
    SET posizione = NULL, attiva = FALSE, google_geo_scade_il = NULL, updated_at = NOW()
    WHERE google_geo_scade_il <= clock_timestamp();
END;
$$;
