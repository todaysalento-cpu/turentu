-- Applicare prima di distribuire il nuovo checkout PopBus.
-- Le richieste storiche restano senza scadenza cliente; nessun prezzo o pagamento viene modificato.
BEGIN;
ALTER TABLE public.richieste_pop_bus
  ADD COLUMN IF NOT EXISTS scadenza_conferma_ore SMALLINT,
  ADD COLUMN IF NOT EXISTS conferma_entro TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'popbus_confirmation_deadline_valid' AND conrelid = 'public.richieste_pop_bus'::regclass) THEN
    ALTER TABLE public.richieste_pop_bus ADD CONSTRAINT popbus_confirmation_deadline_valid CHECK (
      (scadenza_conferma_ore IS NULL AND conferma_entro IS NULL) OR
      (scadenza_conferma_ore IS NOT NULL AND conferma_entro IS NOT NULL AND
       scadenza_conferma_ore IN (48,24,6) AND start_datetime IS NOT NULL AND
       conferma_entro = start_datetime - make_interval(hours => scadenza_conferma_ore::integer))
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_popbus_confirmation_deadline()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.conferma_entro IS NOT NULL AND
     (NEW.conferma_entro IS DISTINCT FROM OLD.conferma_entro OR
      NEW.scadenza_conferma_ore IS DISTINCT FROM OLD.scadenza_conferma_ore) THEN
    RAISE EXCEPTION 'La scadenza di conferma della richiesta non puo essere modificata';
  END IF;
  IF NEW.conferma_entro IS NOT NULL AND NEW.conferma_entro <= clock_timestamp() THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Termine di conferma PopBus gia trascorso';
    ELSIF OLD.corsa_id IS NULL AND
      (NEW.corsa_id IS NOT NULL OR NEW.stato IN ('in_lavorazione','convertita')) THEN
      RAISE EXCEPTION 'Richiesta PopBus scaduta: conferma non consentita';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_popbus_confirmation_deadline ON public.richieste_pop_bus;
CREATE TRIGGER guard_popbus_confirmation_deadline
  BEFORE INSERT OR UPDATE ON public.richieste_pop_bus
  FOR EACH ROW EXECUTE FUNCTION public.guard_popbus_confirmation_deadline();
COMMIT;
