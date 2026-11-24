BEGIN;

CREATE TABLE IF NOT EXISTS public.event_image_sources (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome VARCHAR(150) NOT NULL,
    dominio VARCHAR(255) NOT NULL UNIQUE,
    ricerca_abilitata BOOLEAN NOT NULL DEFAULT FALSE,
    download_abilitato BOOLEAN NOT NULL DEFAULT FALSE,
    pubblicazione_automatica BOOLEAN NOT NULL DEFAULT FALSE,
    condizioni_utilizzo TEXT,
    licenza TEXT,
    verificato_il TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        NOT download_abilitato
        OR (
            licenza IS NOT NULL
            AND verificato_il IS NOT NULL
        )
    ),

    CHECK (
        NOT pubblicazione_automatica
        OR download_abilitato
    )
);

CREATE TABLE IF NOT EXISTS public.event_image_assets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sha256 VARCHAR(64) NOT NULL UNIQUE,
    cloudinary_public_id TEXT NOT NULL UNIQUE,
    immagine_url TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    larghezza INTEGER NOT NULL DEFAULT 480,
    altezza INTEGER NOT NULL DEFAULT 640,
    formato VARCHAR(10) NOT NULL DEFAULT 'webp',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.event_image_candidates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    evento_id INTEGER NOT NULL
        REFERENCES public.eventi(id)
        ON DELETE CASCADE,

    source_id BIGINT
        REFERENCES public.event_image_sources(id),

    asset_id BIGINT
        REFERENCES public.event_image_assets(id),

    titolo_immagine TEXT,
    pagina_url TEXT,
    immagine_originale_url TEXT NOT NULL,

    confidenza INTEGER NOT NULL DEFAULT 0
        CHECK (confidenza BETWEEN 0 AND 100),

    stato VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (stato IN (
            'pending',
            'approved',
            'rejected',
            'published',
            'error'
        )),

    diritti_verificati BOOLEAN NOT NULL DEFAULT FALSE,
    licenza TEXT,
    attribuzione TEXT,
    note TEXT,
    errore TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,

    UNIQUE (evento_id, immagine_originale_url),

    CHECK (
        stato NOT IN ('approved', 'published')
        OR (
            diritti_verificati
            AND licenza IS NOT NULL
        )
    ),

    CHECK (
        stato <> 'published'
        OR asset_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_event_image_candidates_evento
ON public.event_image_candidates(evento_id);

CREATE INDEX IF NOT EXISTS idx_event_image_candidates_stato
ON public.event_image_candidates(stato);

CREATE OR REPLACE VIEW public.eventi_senza_copertina AS
SELECT
    id,
    titolo,
    categoria,
    citta,
    luogo_nome,
    data_inizio,
    immagine_url
FROM public.eventi
WHERE stato = 'approvato'
  AND data_inizio >= NOW()
  AND NULLIF(TRIM(immagine_url), '') IS NULL;

COMMIT;