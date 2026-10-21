-- MIGRAZIONE PROPOSTA: non eseguire prima di backup e autorizzazione.
BEGIN;
CREATE TABLE IF NOT EXISTS public.popbus_payment_reconciliation (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 riserva_id BIGINT NOT NULL REFERENCES public.popbus_riserve(id) ON DELETE RESTRICT,
 payment_intent_id VARCHAR(255) NOT NULL,
 stato VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (stato IN ('pending','processing','retry','canceled','manual_review')),
 tentativi INTEGER NOT NULL DEFAULT 0 CHECK (tentativi >= 0),
 prossimo_tentativo_at TIMESTAMPTZ,
 ultimo_errore TEXT,
 claimed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT popbus_recon_riserva_uk UNIQUE (riserva_id),
 CONSTRAINT popbus_recon_pi_uk UNIQUE (payment_intent_id)
);
CREATE INDEX IF NOT EXISTS idx_popbus_recon_retry ON public.popbus_payment_reconciliation(stato,prossimo_tentativo_at) WHERE stato IN ('pending','retry','processing');
COMMIT;
