-- TURENTU - NCC Locality Resolver
-- Migrazione 033

BEGIN;

-- Indici catalogo ISTAT
CREATE INDEX IF NOT EXISTS idx_localita_istat_nome
ON public.localita_istat_2021 (lower(btrim(nome)));

CREATE INDEX IF NOT EXISTS idx_localita_istat_loc_id
ON public.localita_istat_2021 (loc_id);

CREATE INDEX IF NOT EXISTS idx_localita_istat_codice_comune
ON public.localita_istat_2021 (codice_istat_comune);

-- Alias delle localita
CREATE TABLE IF NOT EXISTS public.localita_istat_alias (
    id BIGSERIAL PRIMARY KEY,
    localita_gid INTEGER NOT NULL
        REFERENCES public.localita_istat_2021(gid)
        ON DELETE CASCADE,
    alias VARCHAR(255) NOT NULL,
    alias_normalizzato VARCHAR(255) NOT NULL,
    fonte VARCHAR(40) NOT NULL DEFAULT 'MANUALE',
    attivo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT localita_istat_alias_non_vuoto
        CHECK (
            length(btrim(alias)) > 0
            AND length(btrim(alias_normalizzato)) > 0
        ),
    CONSTRAINT localita_istat_alias_univoco_per_localita
        UNIQUE (localita_gid, alias_normalizzato)
);

-- Ricerca alias attivi
CREATE INDEX IF NOT EXISTS idx_localita_istat_alias_ricerca
ON public.localita_istat_alias(alias_normalizzato)
WHERE attivo = TRUE;

CREATE INDEX IF NOT EXISTS idx_localita_istat_alias_gid
ON public.localita_istat_alias(localita_gid);

COMMIT;