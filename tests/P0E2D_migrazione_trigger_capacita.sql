-- TURENTU POPBUS P0-E2D — MIGRAZIONE TRIGGER CAPACITA'
-- Applicare SOLO dopo esito positivo del test P0-E2D e approvazione esplicita.
-- La migrazione e' atomica; NON disabilita trigger o vincoli.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';

CREATE OR REPLACE FUNCTION public.check_posti_disponibili_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  capacita integer;
  picco bigint;
  excluded_id integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    excluded_id := OLD.id;
  END IF;
  -- Serializza INSERT e UPDATE concorrenti sulla medesima corsa.
  SELECT posti_totali INTO capacita
  FROM public.corse
  WHERE id = NEW.corsa_id
  FOR UPDATE;

  IF capacita IS NULL OR capacita <= 0
     OR NEW.posti_richiesti IS NULL OR NEW.posti_richiesti <= 0
     OR NEW.start_offset IS NULL OR NEW.end_offset IS NULL
     OR NEW.start_offset < 0 OR NEW.end_offset <= NEW.start_offset THEN
    RAISE EXCEPTION 'Capacita o indici prenotazione non validi';
  END IF;

  -- In UPDATE la vecchia versione della riga non deve essere contata due volte.
  -- Se corsa_id cambia, la nuova corsa viene verificata integralmente.
  IF EXISTS (
    SELECT 1 FROM public.prenotazioni p
    WHERE p.corsa_id = NEW.corsa_id
      AND (excluded_id IS NULL OR p.id <> excluded_id)
      AND (p.start_offset IS NULL OR p.end_offset IS NULL
           OR p.start_offset < 0 OR p.end_offset <= p.start_offset
           OR p.posti_richiesti IS NULL OR p.posti_richiesti <= 0)
  ) THEN
    RAISE EXCEPTION 'Prenotazioni storiche con segmenti non validi';
  END IF;

  WITH tratte AS (
    SELECT p.start_offset AS s, p.end_offset AS e, p.posti_richiesti AS posti
    FROM public.prenotazioni p
    WHERE p.corsa_id = NEW.corsa_id
      AND (excluded_id IS NULL OR p.id <> excluded_id)
    UNION ALL
    SELECT NEW.start_offset, NEW.end_offset, NEW.posti_richiesti
  ), eventi AS (
    SELECT s AS punto, posti::bigint AS delta FROM tratte
    UNION ALL
    SELECT e, -posti::bigint FROM tratte
  ), delta AS (
    SELECT punto, SUM(delta) AS valore
    FROM eventi GROUP BY punto
  ), occupazione AS (
    SELECT SUM(valore) OVER (ORDER BY punto) AS posti
    FROM delta
  )
  SELECT COALESCE(MAX(posti), 0) INTO picco FROM occupazione;

  IF picco > capacita THEN
    RAISE EXCEPTION 'Capacita insufficiente: %/%', picco, capacita;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_check_posti ON public.prenotazioni;
CREATE TRIGGER trg_check_posti
BEFORE INSERT OR UPDATE OF corsa_id, start_offset, end_offset, posti_richiesti
ON public.prenotazioni
FOR EACH ROW
EXECUTE FUNCTION public.check_posti_disponibili_trigger();

COMMIT;
