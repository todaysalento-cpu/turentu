BEGIN;

CREATE TABLE IF NOT EXISTS public.event_image_publication_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_by INTEGER,
    stato VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (stato IN (
            'pending',
            'running',
            'completed',
            'partial',
            'error'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.event_image_publication_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id BIGINT NOT NULL
        REFERENCES public.event_image_publication_jobs(id)
        ON DELETE CASCADE,
    candidate_id BIGINT NOT NULL
        REFERENCES public.event_image_candidates(id),
    stato VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (stato IN (
            'pending',
            'running',
            'published',
            'skipped',
            'error'
        )),
    tentativi INTEGER NOT NULL DEFAULT 0,
    errore TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    UNIQUE(job_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_image_jobs_stato
ON public.event_image_publication_jobs(stato);

CREATE INDEX IF NOT EXISTS idx_image_items_job
ON public.event_image_publication_items(job_id, stato);

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_items_active
ON public.event_image_publication_items(candidate_id)
WHERE stato IN ('pending', 'running');

COMMIT;