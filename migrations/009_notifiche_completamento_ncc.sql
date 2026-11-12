BEGIN;

CREATE TABLE IF NOT EXISTS public.notifiche_completamento_ncc (
  utente_id INTEGER PRIMARY KEY REFERENCES public.utente(id) ON DELETE CASCADE,
  completo BOOLEAN,
  completamento_notificato BOOLEAN NOT NULL DEFAULT false,
  ultimo_promemoria TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.notifiche_completamento_ncc_email (
  notifica_id INTEGER PRIMARY KEY REFERENCES public.notifications(id) ON DELETE CASCADE,
  tentativi INTEGER NOT NULL DEFAULT 0,
  prossimo_tentativo TIMESTAMPTZ NOT NULL DEFAULT now(),
  inviata_il TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifiche_completamento_ncc_email_in_attesa_idx
  ON public.notifiche_completamento_ncc_email (prossimo_tentativo)
  WHERE inviata_il IS NULL AND tentativi < 5;

-- Gli operatori già esistenti vengono osservati prima di inviare un avviso di completamento.
INSERT INTO public.notifiche_completamento_ncc (utente_id)
SELECT id FROM public.utente WHERE lower(btrim(tipo)) = 'autista' AND eliminato_il IS NULL
ON CONFLICT (utente_id) DO NOTHING;

COMMIT;
