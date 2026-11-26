
BEGIN;

ALTER TABLE public.ncc_prenotazioni_esterne

    ADD COLUMN IF NOT EXISTS origine_normalizzata TEXT,
    ADD COLUMN IF NOT EXISTS origine_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS origine_lon DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS origine_place_id TEXT,
    ADD COLUMN IF NOT EXISTS origine_stato_geo VARCHAR(30)
        NOT NULL DEFAULT 'DA_ELABORARE',
    ADD COLUMN IF NOT EXISTS origine_verificata_il TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS origine_fonte_geo VARCHAR(30),
    ADD COLUMN IF NOT EXISTS origine_dettaglio_geo JSONB,

    ADD COLUMN IF NOT EXISTS destinazione_normalizzata TEXT,
    ADD COLUMN IF NOT EXISTS destinazione_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS destinazione_lon DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS destinazione_place_id TEXT,
    ADD COLUMN IF NOT EXISTS destinazione_stato_geo VARCHAR(30)
        NOT NULL DEFAULT 'DA_ELABORARE',
    ADD COLUMN IF NOT EXISTS destinazione_verificata_il TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS destinazione_fonte_geo VARCHAR(30),
    ADD COLUMN IF NOT EXISTS destinazione_dettaglio_geo JSONB;

CREATE INDEX IF NOT EXISTS idx_ncc_origine_stato_geo
    ON public.ncc_prenotazioni_esterne
    (operatore_id, origine_stato_geo)
    WHERE annullata_il IS NULL;

CREATE INDEX IF NOT EXISTS idx_ncc_destinazione_stato_geo
    ON public.ncc_prenotazioni_esterne
    (operatore_id, destinazione_stato_geo)
    WHERE annullata_il IS NULL;

ALTER TABLE public.ncc_prenotazioni_esterne
ADD COLUMN IF NOT EXISTS origine_geo_scade_il TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS destinazione_geo_scade_il TIMESTAMPTZ;
ALTER TABLE public.ncc_prenotazioni_esterne ADD CONSTRAINT ncc_origine_coordinate_valide CHECK ((origine_lat IS NULL AND origine_lon IS NULL) OR (origine_lat IS NOT NULL AND origine_lon IS NOT NULL AND origine_lat BETWEEN -90 AND 90 AND origine_lon BETWEEN -180 AND 180 AND NOT (origine_lat = 0 AND origine_lon = 0)));
ALTER TABLE public.ncc_prenotazioni_esterne ADD CONSTRAINT ncc_destinazione_coordinate_valide CHECK ((destinazione_lat IS NULL AND destinazione_lon IS NULL) OR (destinazione_lat IS NOT NULL AND destinazione_lon IS NOT NULL AND destinazione_lat BETWEEN -90 AND 90 AND destinazione_lon BETWEEN -180 AND 180 AND NOT (destinazione_lat = 0 AND destinazione_lon = 0)));

ALTER TABLE public.ncc_prenotazioni_esterne ADD CONSTRAINT ncc_origine_stato_geo_valido CHECK (origine_stato_geo IN ('DA_ELABORARE','VALIDATO_AUTO','VALIDATO_MANUALE','VALIDATO_CATALOGO','DA_VERIFICARE','AMBIGUO','FUORI_COMUNE','NON_TROVATO','ERRORE_API'));
ALTER TABLE public.ncc_prenotazioni_esterne ADD CONSTRAINT ncc_destinazione_stato_geo_valido CHECK (destinazione_stato_geo IN ('DA_ELABORARE','VALIDATO_AUTO','VALIDATO_MANUALE','VALIDATO_CATALOGO','DA_VERIFICARE','AMBIGUO','FUORI_COMUNE','NON_TROVATO','ERRORE_API'));

CREATE OR REPLACE FUNCTION public.ncc_invalida_geografia()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $ncc$
BEGIN
 IF NEW.origine IS DISTINCT FROM OLD.origine THEN
 NEW.origine_normalizzata := NULL;
 NEW.origine_lat := NULL;
 NEW.origine_lon := NULL;
 NEW.origine_place_id := NULL;
 NEW.origine_verificata_il := NULL;
 NEW.origine_fonte_geo := NULL;
 NEW.origine_dettaglio_geo := NULL;
 NEW.origine_geo_scade_il := NULL;
 NEW.origine_stato_geo := 'DA_ELABORARE';
 END IF;
 IF NEW.destinazione IS DISTINCT FROM OLD.destinazione THEN
 NEW.destinazione_normalizzata := NULL;
 NEW.destinazione_lat := NULL;
 NEW.destinazione_lon := NULL;
 NEW.destinazione_place_id := NULL;
 NEW.destinazione_verificata_il := NULL;
 NEW.destinazione_fonte_geo := NULL;
 NEW.destinazione_dettaglio_geo := NULL;
 NEW.destinazione_geo_scade_il := NULL;
 NEW.destinazione_stato_geo := 'DA_ELABORARE';
 END IF;
 RETURN NEW;
END;
$ncc$;
DROP TRIGGER IF EXISTS trg_ncc_invalida_geografia ON public.ncc_prenotazioni_esterne;
CREATE TRIGGER trg_ncc_invalida_geografia
BEFORE UPDATE OF origine, destinazione ON public.ncc_prenotazioni_esterne
FOR EACH ROW EXECUTE FUNCTION public.ncc_invalida_geografia();

COMMIT;
