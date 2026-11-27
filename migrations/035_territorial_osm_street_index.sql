BEGIN;

CREATE TABLE public.territorial_osm_strade_importazioni (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    versione TEXT NOT NULL,
    fonte_dataset TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL UNIQUE,
    data_importazione TIMESTAMPTZ NOT NULL DEFAULT now(),
    totale_strade INTEGER NOT NULL CHECK (totale_strade > 0),
    totale_alias INTEGER NOT NULL CHECK (totale_alias >= 0),
    totale_comuni INTEGER NOT NULL CHECK (totale_comuni > 0),
    stato TEXT NOT NULL DEFAULT 'IN_CORSO'
        CHECK (stato IN ('IN_CORSO', 'COMPLETATO')),
    attiva BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (NOT attiva OR stato = 'COMPLETATO')
);

CREATE UNIQUE INDEX territorial_osm_importazione_attiva
ON public.territorial_osm_strade_importazioni (attiva)
WHERE attiva = TRUE;


CREATE TABLE public.territorial_osm_strade (
    importazione_id BIGINT NOT NULL
        REFERENCES public.territorial_osm_strade_importazioni(id),

    id BIGINT NOT NULL,
    osm_way_id BIGINT NOT NULL CHECK (osm_way_id > 0),

    codice_istat_comune VARCHAR(6) NOT NULL
        CHECK (codice_istat_comune ~ '^[0-9]{6}$'),

    comune TEXT NOT NULL,
    nome TEXT NOT NULL,
    nome_normalizzato TEXT NOT NULL,
    highway TEXT NOT NULL,

    accesso TEXT,
    motor_vehicle TEXT,
    tags JSONB NOT NULL,

    geom geometry(MultiLineString, 4326) NOT NULL,

    PRIMARY KEY (importazione_id, id),

    UNIQUE (
        importazione_id,
        osm_way_id,
        codice_istat_comune
    ),

    CHECK (NOT ST_IsEmpty(geom)),
    CHECK (ST_IsValid(geom)),
    CHECK (ST_Length(geom) > 0)
);


CREATE TABLE public.territorial_osm_strade_alias (
    importazione_id BIGINT NOT NULL,
    strada_id BIGINT NOT NULL,

    alias TEXT NOT NULL,
    alias_normalizzato TEXT NOT NULL,
    fonte TEXT NOT NULL,

    FOREIGN KEY (importazione_id, strada_id)
        REFERENCES public.territorial_osm_strade(
            importazione_id, id
        )
        ON DELETE CASCADE,

    PRIMARY KEY (
        importazione_id,
        strada_id,
        alias_normalizzato,
        fonte
    )
);


CREATE INDEX territorial_osm_strade_comune_nome
ON public.territorial_osm_strade (
    importazione_id,
    codice_istat_comune,
    nome_normalizzato
);

CREATE INDEX territorial_osm_strade_geom
ON public.territorial_osm_strade
USING GIST (geom);

CREATE INDEX territorial_osm_strade_osm_id
ON public.territorial_osm_strade (osm_way_id);

CREATE INDEX territorial_osm_alias_ricerca
ON public.territorial_osm_strade_alias (
    importazione_id,
    alias_normalizzato,
    fonte
);


CREATE VIEW public.territorial_osm_strade_attive AS
SELECT s.*
FROM public.territorial_osm_strade s
JOIN public.territorial_osm_strade_importazioni i
    ON i.id = s.importazione_id
WHERE i.attiva = TRUE
  AND i.stato = 'COMPLETATO';


CREATE VIEW public.territorial_osm_strade_alias_attivi AS
SELECT a.*
FROM public.territorial_osm_strade_alias a
JOIN public.territorial_osm_strade_importazioni i
    ON i.id = a.importazione_id
WHERE i.attiva = TRUE
  AND i.stato = 'COMPLETATO';

COMMIT;
