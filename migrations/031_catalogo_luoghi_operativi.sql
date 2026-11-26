BEGIN;

CREATE TABLE public.catalogo_luoghi (
 id BIGSERIAL PRIMARY KEY,
 codice TEXT NOT NULL UNIQUE,
 nome TEXT NOT NULL,
 categoria VARCHAR(30) NOT NULL,
 codice_iata VARCHAR(3) UNIQUE,
 codice_istat_comune VARCHAR(6),
 comune TEXT,
 provincia VARCHAR(2),
 regione TEXT,
 paese VARCHAR(2) NOT NULL DEFAULT 'IT',
 attivo BOOLEAN NOT NULL DEFAULT FALSE,
 nodo_territoriale_id BIGINT REFERENCES public.nodi_territoriali(id) ON DELETE SET NULL,
 creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
 aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT catalogo_luoghi_categoria_valida CHECK (categoria IN ('AEROPORTO','STAZIONE','PORTO','TERMINAL_BUS','OSPEDALE','STADIO','STRUTTURA_RICETTIVA','PARCHEGGIO','POLO_COMMERCIALE','ALTRO')),
 CONSTRAINT catalogo_luoghi_iata_valido CHECK (codice_iata IS NULL OR (categoria = 'AEROPORTO' AND codice_iata ~ '^[A-Z]{3}$'))
);

CREATE TABLE public.catalogo_luoghi_alias (
 id BIGSERIAL PRIMARY KEY,
 luogo_id BIGINT NOT NULL REFERENCES public.catalogo_luoghi(id) ON DELETE CASCADE,
 alias TEXT NOT NULL,
 alias_normalizzato TEXT NOT NULL,
 attivo BOOLEAN NOT NULL DEFAULT TRUE,
 creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (luogo_id, alias_normalizzato)
);
CREATE INDEX idx_catalogo_alias_ricerca ON public.catalogo_luoghi_alias(alias_normalizzato) WHERE attivo;

CREATE TABLE public.catalogo_punti_operativi (
 id BIGSERIAL PRIMARY KEY,
 luogo_id BIGINT NOT NULL REFERENCES public.catalogo_luoghi(id) ON DELETE CASCADE,
 codice TEXT NOT NULL UNIQUE,
 nome TEXT NOT NULL,
 indirizzo TEXT,
 tipo VARCHAR(30) NOT NULL,
 posizione geometry(Point,4326),
 abilitato_ncc BOOLEAN NOT NULL DEFAULT FALSE,
 abilitato_pixel BOOLEAN NOT NULL DEFAULT FALSE,
 abilitato_popbus BOOLEAN NOT NULL DEFAULT FALSE,
 prelievo_consentito BOOLEAN NOT NULL DEFAULT FALSE,
 discesa_consentita BOOLEAN NOT NULL DEFAULT FALSE,
 tipi_veicolo_ammessi TEXT[],
 fonte_geo VARCHAR(30),
 riferimento_fonte TEXT,
 google_place_id TEXT,
 geo_scade_il TIMESTAMPTZ,
 verificato BOOLEAN NOT NULL DEFAULT FALSE,
 verificato_il TIMESTAMPTZ,
 attivo BOOLEAN NOT NULL DEFAULT FALSE,
 note_accesso TEXT,
 pixel_fermata_id BIGINT REFERENCES public.pixel_fermate(id) ON DELETE SET NULL,
 creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
 aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT catalogo_punti_tipo_valido CHECK (tipo IN ('ARRIVI','PARTENZE','INCONTRO_NCC','FERMATA_POPBUS','FERMATA_BUS','INGRESSO','PARCHEGGIO','GENERICO')),
 CONSTRAINT catalogo_punti_coordinate_valide CHECK (posizione IS NULL OR (NOT ST_IsEmpty(posizione) AND ST_Y(posizione) BETWEEN -90 AND 90 AND ST_X(posizione) BETWEEN -180 AND 180 AND NOT (ST_X(posizione)=0 AND ST_Y(posizione)=0))),
 CONSTRAINT catalogo_punti_verifica_valida CHECK (NOT verificato OR (posizione IS NOT NULL AND verificato_il IS NOT NULL AND fonte_geo IS NOT NULL)),
 CONSTRAINT catalogo_punti_attivazione_valida CHECK (NOT attivo OR (verificato AND posizione IS NOT NULL AND (prelievo_consentito OR discesa_consentita)))
);
CREATE INDEX idx_catalogo_punti_posizione ON public.catalogo_punti_operativi USING GIST(posizione);
CREATE INDEX idx_catalogo_punti_luogo ON public.catalogo_punti_operativi(luogo_id);
CREATE INDEX idx_catalogo_punti_ncc ON public.catalogo_punti_operativi(luogo_id) WHERE attivo AND verificato AND abilitato_ncc;

ALTER TABLE public.ncc_prenotazioni_esterne
 ADD COLUMN origine_punto_operativo_id BIGINT REFERENCES public.catalogo_punti_operativi(id),
 ADD COLUMN destinazione_punto_operativo_id BIGINT REFERENCES public.catalogo_punti_operativi(id);

CREATE OR REPLACE FUNCTION public.ncc_invalida_punti_operativi()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $ncc$
BEGIN
 IF NEW.origine IS DISTINCT FROM OLD.origine THEN
 NEW.origine_punto_operativo_id := NULL;
 END IF;
 IF NEW.destinazione IS DISTINCT FROM OLD.destinazione THEN
 NEW.destinazione_punto_operativo_id := NULL;
 END IF;
 RETURN NEW;
END;
$ncc$;

CREATE TRIGGER trg_ncc_invalida_punti_operativi
BEFORE UPDATE OF origine, destinazione ON public.ncc_prenotazioni_esterne
FOR EACH ROW EXECUTE FUNCTION public.ncc_invalida_punti_operativi();

COMMIT;
