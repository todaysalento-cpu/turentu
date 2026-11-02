-- TURENTU POPBUS V2 - FASE 5E
-- Diagnostica schema in SOLA LETTURA. Non modifica dati.
-- Eseguire in psql su database di TEST, oppure su Render solo se si desidera
-- verificare la struttura: nessuna DML/DDL e nessun lock esplicito.
BEGIN READ ONLY;

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'popbus_attivazioni', 'offerte_autisti', 'popbus_ar_accettazioni',
    'ar_gruppi', 'richieste_pop_bus', 'popbus_attivazione_richieste'
  )
  AND column_name IN (
    'id', 'attivazione_id', 'offerta_id', 'autista_id', 'veicolo_id',
    'stato', 'expires_at', 'accepted_at', 'ar_group_id', 'ar_tratta',
    'ar_vincolata', 'richiesta_id', 'attiva', 'corsa_id', 'cliente_id'
  )
ORDER BY table_name, ordinal_position;

SELECT conrelid::regclass AS tabella, conname AS vincolo,
       pg_get_constraintdef(oid) AS definizione
FROM pg_constraint
WHERE conrelid IN (
  'public.popbus_attivazioni'::regclass,
  'public.offerte_autisti'::regclass,
  'public.popbus_ar_accettazioni'::regclass,
  'public.ar_gruppi'::regclass,
  'public.richieste_pop_bus'::regclass,
  'public.popbus_attivazione_richieste'::regclass
)
ORDER BY conrelid::regclass::text, conname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN (
    'popbus_attivazioni', 'offerte_autisti', 'popbus_ar_accettazioni',
    'ar_gruppi', 'richieste_pop_bus', 'popbus_attivazione_richieste'
  )
ORDER BY tablename, indexname;

ROLLBACK;
