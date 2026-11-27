BEGIN;

DO $$
DECLARE
  old_constraint name;
BEGIN
  SELECT conname INTO STRICT old_constraint
    FROM pg_constraint
   WHERE conrelid = 'public.ncc_prenotazioni_esterne'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%num_nonnulls(volo_numero, volo_aeroporto, volo_direzione, volo_programmato_il, volo_aggiornato_il)%';

  EXECUTE format('ALTER TABLE public.ncc_prenotazioni_esterne DROP CONSTRAINT %I', old_constraint);
END $$;

ALTER TABLE public.ncc_prenotazioni_esterne
  ADD CONSTRAINT ncc_prenotazioni_esterne_dati_volo_check CHECK (
    num_nonnulls(volo_numero, volo_aeroporto, volo_direzione, volo_programmato_il, volo_aggiornato_il) = 0
    OR num_nonnulls(volo_aeroporto, volo_direzione, volo_programmato_il, volo_aggiornato_il) = 4
  );

COMMIT;
