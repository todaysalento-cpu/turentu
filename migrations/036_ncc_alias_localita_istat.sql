BEGIN;

LOCK TABLE public.localita_istat_alias
IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM public.localita_istat_2021
        WHERE gid = 232
          AND nome = 'Giuliano'
          AND codice_istat_comune = '075019'
    ) THEN
        RAISE EXCEPTION 'LOCALITA GIULIANO NON COMPATIBILE';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.localita_istat_2021
        WHERE gid = 429
          AND nome = 'Leuca'
          AND codice_istat_comune = '075019'
    ) THEN
        RAISE EXCEPTION 'LOCALITA LEUCA NON COMPATIBILE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.localita_istat_alias
        WHERE (
            alias_normalizzato = 'giuliano di lecce'
            AND localita_gid <> 232
        )
        OR (
            alias_normalizzato = 'santa maria di leuca'
            AND localita_gid <> 429
        )
    ) THEN
        RAISE EXCEPTION 'CONFLITTO ALIAS LOCALITA';
    END IF;

END $$;

INSERT INTO public.localita_istat_alias (
    localita_gid,
    alias,
    alias_normalizzato,
    fonte,
    attivo
)
VALUES
(
    232,
    'Giuliano di Lecce',
    'giuliano di lecce',
    'MANUALE',
    TRUE
),
(
    429,
    'Santa Maria di Leuca',
    'santa maria di leuca',
    'MANUALE',
    TRUE
)
ON CONFLICT (
    localita_gid,
    alias_normalizzato
)
DO NOTHING;

DO $$
BEGIN
    IF (
        SELECT COUNT(*)
        FROM public.localita_istat_alias
        WHERE attivo = TRUE
          AND (
            (
                localita_gid = 232
                AND alias_normalizzato = 'giuliano di lecce'
            )
            OR
            (
                localita_gid = 429
                AND alias_normalizzato = 'santa maria di leuca'
            )
          )
    ) <> 2 THEN
        RAISE EXCEPTION 'VERIFICA ALIAS FALLITA';
    END IF;
END $$;

COMMIT;